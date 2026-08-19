import Anthropic from '@anthropic-ai/sdk'
import { apiLogger } from '@/lib/logger'
import { recordLlmCall } from '@/lib/usage/ledger'
import { recordPiiEgress } from '@/lib/usage/ai-guard'
import { ambientOrganization } from '@/lib/tenant-database-context'
import { qwenClient, qwenConfigured, qwenModel } from './qwen'
import { modelTier, UNLIMITED_MODEL_ALLOWANCE, type ModelAllowance } from '@/lib/usage/model-tiers'
import { AGENT_MODEL_TURN_TIMEOUT_MS } from '@/lib/agents/timeouts'
import {
  type IRMessage,
  irUser,
  irToolResults,
  irFromAnthropic,
  toAnthropicMessages,
} from './ir'

export type ToolDefinition = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/**
 * Who to bill a call to. Optional everywhere: a call without context still
 * runs, it just is not recorded. Keeps every existing caller compiling
 * unchanged while new call sites opt in.
 */
export type LedgerContext = {
  organizationId: string
  /** The run's owner, so spend can be attributed to a person, not just a tenant. */
  userId?: string | null
  surface?: 'agent_turn' | 'structured' | 'headline' | 'embedding' | 'eval_judge'
  agentExecutionId?: string | null
  flowRunId?: string | null
  flowRunStepId?: string | null
}

export type ToolCall = {
  id: string
  name: string
  input: Record<string, unknown>
}

export type ToolResult = {
  toolCallId: string
  content: string
  isError?: boolean
}

/**
 * Token counts split by BILLING bucket. Cache reads bill at roughly 0.1x and
 * cache writes at roughly 1.25x, so collapsing these into one number (as this
 * type previously did) makes the total impossible to convert to dollars —
 * especially here, where withRollingCache means most turns are cache-heavy.
 */
export type TokenUsage = {
  inputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  outputTokens: number
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }
}

/**
 * Total tokens for quota purposes — every input bucket plus output. This is
 * exactly what `inputTokens + outputTokens` meant before the split, so callers
 * enforcing budgets keep their current behavior.
 */
export function billableTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens + usage.outputTokens
}

/**
 * Which ENDPOINT served a call, for cost and performance attribution.
 *
 * Deliberately not `ProviderKind`, which answers a different question: that
 * type describes the WIRE FORMAT of a persisted IR block, and Qwen's blocks are
 * Anthropic-shaped because DashScope speaks the Messages API. Reusing it here
 * billed every Qwen turn to 'anthropic' — the per-model console then showed
 * Qwen spend under Anthropic, and the Claude-usage caps counted Qwen runs
 * against the Claude allowance they exist to relieve.
 */
export type ProviderId = 'anthropic' | 'qwen'

export type ModelTurn = {
  text: string
  toolCalls: ToolCall[]
  usage: TokenUsage
  /** Which endpoint actually served this turn — the chain may have fallen back. */
  provider: ProviderId
  /** The model string actually sent, which may differ from the one requested. */
  servedModel: string
  /** Wall-clock for the call, so the console can report latency beside cost. */
  latencyMs: number
}

// The transcript is provider-native message JSON. It is persisted on the
// execution and replayed verbatim on resume, so thinking/tool_use blocks
// survive a pause round-trip unchanged.
export interface ModelRunner {
  readonly model: string
  start(input: string): unknown[]
  appendUserMessage(transcript: unknown[], content: string): void
  appendToolResults(transcript: unknown[], results: ToolResult[]): void
  next(transcript: unknown[], system: string, tools: ToolDefinition[], ledger?: LedgerContext): Promise<ModelTurn>
}

const ADAPTIVE_THINKING_MODELS = /^claude-(opus-4-[678]|sonnet-(4-6|5)|fable-5|mythos-5)/

// Bound a single model call below the BullMQ job lock (20m, see
// queue/config.ts) so a hung/slow call can't outlive the lock and make a run
// both dead-letter (stalled) and complete. The SDK `timeout` only wraps the
// fetch (which resolves at response HEADERS for a stream), so it bounds
// non-streaming calls; STREAM_DEADLINE_MS is an explicit end-to-end cap passed
// as an AbortSignal to the streaming turn to bound the body read too.
const LLM_TIMEOUT_MS = AGENT_MODEL_TURN_TIMEOUT_MS
// The SDK default is 2 (covers 429/overload/5xx with backoff); the 19-min turn
// timeout leaves ample room. Overridable, but never below 1.
const LLM_MAX_RETRIES = Math.max(1, Number(process.env.LLM_MAX_RETRIES) || 2)
const STREAM_DEADLINE_MS = AGENT_MODEL_TURN_TIMEOUT_MS

const CACHE_CONTROL = { type: 'ephemeral' as const }

/**
 * Which dialect of the Messages API an endpoint speaks.
 *
 * Claude (api.anthropic.com) accepts the whole surface. Qwen reaches us through
 * DashScope's Anthropic-COMPATIBLE endpoint, which implements the core of that
 * API and not its recent extensions: block-array `system` carrying
 * `cache_control` breakpoints, `thinking`, and structured `output_config`.
 *
 * Sending those to a compat endpoint is a SAFETY problem, not a performance
 * one. The system prompt is where GUARDRAIL_RULE and the untrusted-data fencing
 * live, so an endpoint that rejects — or worse, quietly ignores — the
 * block-array form drops every boundary along with it, and nothing in the reply
 * says so: the run just proceeds with an unguarded model. 'compat' therefore
 * sends the plainest shape the Messages API defines (string `system`, no cache
 * breakpoints, no extension fields), trading prompt caching for the guarantee
 * that the instructions actually arrive.
 */
export type WireDialect = 'anthropic' | 'compat'

/**
 * Add a rolling prompt-cache breakpoint on the last message so the growing
 * transcript prefix is cached turn-over-turn (cache reads bill ~0.1x). Operates
 * on a COPY — the persisted transcript (replayed verbatim on resume, where the
 * API rejects modified blocks) is never mutated.
 */
function withRollingCache(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages
  const out = messages.slice()
  const i = out.length - 1
  const last = out[i]
  if (typeof last.content === 'string') {
    out[i] = { ...last, content: [{ type: 'text', text: last.content, cache_control: CACHE_CONTROL }] }
  } else if (Array.isArray(last.content) && last.content.length > 0) {
    const blocks = last.content.slice()
    blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: CACHE_CONTROL } as (typeof blocks)[number]
    out[i] = { ...last, content: blocks }
  }
  return out
}

/**
 * Shape one turn's request for a dialect.
 *
 * Pure and exported because the failure it guards against is SILENT: a compat
 * endpoint that drops the block-array `system` still returns a perfectly
 * ordinary-looking answer, just from a model that never saw the guardrails. The
 * only way to know the instructions arrived is to assert on the request we
 * build, which is what lib/llm/__tests__/wire-dialect.test.ts does.
 */
export function buildMessagesRequest(input: {
  model: string
  system: string
  tools: ToolDefinition[]
  messages: Anthropic.MessageParam[]
  dialect: WireDialect
}): Anthropic.MessageStreamParams {
  const full = input.dialect === 'anthropic'
  return {
    model: input.model,
    max_tokens: 32000,
    // Full dialect: a breakpoint on the system block caches tools + system
    // together (they precede messages in the cache prefix), so they bill at
    // ~0.1x on every repeat turn instead of full price each turn. Compat sends
    // the SAME text as a plain string — identical instructions, no caching.
    system: full ? [{ type: 'text', text: input.system, cache_control: CACHE_CONTROL }] : input.system,
    ...(full && ADAPTIVE_THINKING_MODELS.test(input.model) ? { thinking: { type: 'adaptive' as const } } : {}),
    ...(input.tools.length
      ? {
          tools: input.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema as Anthropic.Tool['input_schema'],
          })),
        }
      : {}),
    // Rolling cache is applied to the TRANSLATED native messages, never to the
    // persisted IR (which is replayed verbatim and must stay unmodified).
    messages: full ? withRollingCache(input.messages) : input.messages,
  }
}

/**
 * One concrete provider. Stateless except for its SDK client: it translates the
 * IR transcript to its native format, calls the API, and (on success) appends
 * the assistant reply back onto the IR transcript as an IRAssistantMessage. It
 * never mutates the transcript on failure, so the AgentRunner can retry the same
 * IR on the next provider in the chain.
 */
interface Provider {
  /** The endpoint this step bills to. */
  readonly providerId: ProviderId
  readonly model: string
  next(ir: IRMessage[], system: string, tools: ToolDefinition[]): Promise<ModelTurn>
}

// Anthropic-wire provider. Serves BOTH Claude (api.anthropic.com) and Qwen
// (DashScope's Anthropic-compatible endpoint) — same Messages API, different
// client — so one implementation covers both. The client is injected by
// buildProvider so this class stays free of endpoint/key selection.
class AnthropicProvider implements Provider {
  constructor(
    /** Which endpoint this instance points at — attribution, not wire format. */
    readonly providerId: ProviderId,
    readonly model: string,
    private readonly client: Anthropic,
    /** Which request shape this endpoint accepts. See WireDialect. */
    private readonly dialect: WireDialect,
  ) {}

  async next(ir: IRMessage[], system: string, tools: ToolDefinition[]): Promise<ModelTurn> {
    const startedAt = Date.now()
    const stream = this.client.messages.stream(
      buildMessagesRequest({
        model: this.model,
        system,
        tools,
        messages: toAnthropicMessages(ir),
        dialect: this.dialect,
      }),
      { signal: AbortSignal.timeout(STREAM_DEADLINE_MS) },
    )
    const message = await stream.finalMessage()
    ir.push(irFromAnthropic(message))

    return {
      text: message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim(),
      toolCalls: message.content
        .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
        .map((block) => ({
          id: block.id,
          name: block.name,
          input: (block.input || {}) as Record<string, unknown>,
        })),
      usage: {
        inputTokens: message.usage.input_tokens,
        cacheWriteTokens: message.usage.cache_creation_input_tokens || 0,
        cacheReadTokens: message.usage.cache_read_input_tokens || 0,
        outputTokens: message.usage.output_tokens,
      },
      provider: this.providerId,
      servedModel: this.model,
      latencyMs: Date.now() - startedAt,
    }
  }
}

/** An Anthropic SDK client for Claude (api.anthropic.com). */
function claudeClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured')
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: LLM_TIMEOUT_MS, maxRetries: LLM_MAX_RETRIES })
}

/**
 * The agent-facing runner. Holds an ordered chain of providers over ONE
 * provider-neutral IR transcript. Each turn tries the primary provider; on an
 * availability failure (quota/auth/overload) it falls back to the next provider
 * IN THE SAME TURN, on the same transcript — so a provider outage degrades to
 * the other instead of failing the run. Non-availability errors (a real bug in
 * our request) propagate immediately; retrying elsewhere wouldn't help.
 */
class AgentRunner implements ModelRunner {
  readonly model: string

  constructor(private readonly chain: Provider[]) {
    if (chain.length === 0) throw new Error('No model provider configured — set ANTHROPIC_API_KEY (or QWEN_API_KEY + QWEN_BASE_URL).')
    this.model = chain[0].model
  }

  start(input: string): unknown[] {
    return [irUser(input)]
  }

  appendUserMessage(transcript: unknown[], content: string) {
    ;(transcript as IRMessage[]).push(irUser(content))
  }

  appendToolResults(transcript: unknown[], results: ToolResult[]) {
    ;(transcript as IRMessage[]).push(
      irToolResults(results.map((r) => ({ toolCallId: r.toolCallId, content: r.content, isError: r.isError }))),
    )
  }

  async next(transcript: unknown[], system: string, tools: ToolDefinition[], ledger?: LedgerContext): Promise<ModelTurn> {
    const ir = transcript as IRMessage[]
    let lastError: unknown
    for (let i = 0; i < this.chain.length; i += 1) {
      const provider = this.chain[i]
      try {
        const turn = await provider.next(ir, system, tools)
        // Recorded here rather than inside the provider so a fallback writes
        // exactly one row — for the attempt that actually served the turn.
        // Fire-and-forget: the ledger is best-effort and must not add latency.
        if (ledger) {
          void recordLlmCall({
            organizationId: ledger.organizationId,
            userId: ledger.userId ?? null,
            surface: ledger.surface ?? 'agent_turn',
            provider: turn.provider,
            model: turn.servedModel,
            usage: turn.usage,
            latencyMs: turn.latencyMs,
            agentExecutionId: ledger.agentExecutionId,
            flowRunId: ledger.flowRunId,
            flowRunStepId: ledger.flowRunStepId,
          })
        }
        return turn
      } catch (error) {
        lastError = error
        // Only fall back on availability failures, and only if a fallback exists.
        if (!isProviderAvailabilityError(error) || i === this.chain.length - 1) throw error
        apiLogger.warn('model-runner: provider unavailable mid-run, falling back', {
          from: `${provider.providerId}:${provider.model}`,
          to: `${this.chain[i + 1].providerId}:${this.chain[i + 1].model}`,
          status: (error as { status?: number }).status,
          error: error instanceof Error ? error.message.slice(0, 200) : String(error),
        })
      }
    }
    throw lastError
  }
}

// ---------------------------------------------------------------------------
// Default models. Both Claude and Qwen speak the Anthropic Messages API (Qwen
// via DashScope's Anthropic-compatible endpoint), so routing picks an ENDPOINT,
// not a wire format. AGENT_MODEL drives agent runs; SUMMARY_MODEL drives cheap
// surfaces (headlines, run Q&A). Qwen activates when QWEN_API_KEY/QWEN_BASE_URL/
// QWEN_MODEL are set; ChatGPT/OpenAI is no longer used.
// ---------------------------------------------------------------------------
export const DEFAULT_AGENT_MODEL = process.env.AGENT_MODEL?.trim() || 'claude-sonnet-5'
export const DEFAULT_SUMMARY_MODEL = process.env.SUMMARY_MODEL?.trim() || 'claude-haiku-4-5'
const FALLBACK_CLAUDE_MODEL = 'claude-opus-4-8'
// Where a frontier model lands when this actor's frontier allowance is spent:
// still Claude, still capable, a fraction of the price. See usage/model-allowance.ts.
const DOWNGRADE_CLAUDE_MODEL = 'claude-sonnet-5'
// UI id for the Qwen slot; the exact model string is resolved from QWEN_MODEL.
const FALLBACK_QWEN_MODEL = 'qwen-3.7'

const hasQwen = () => qwenConfigured()
const hasAnthropic = () => !!process.env.ANTHROPIC_API_KEY
const isClaude = (model: string) => model.startsWith('claude')

/** A routed step: which endpoint (Claude vs Qwen) and the model to send it. */
type RouteStep = { target: 'claude' | 'qwen'; model: string }

/**
 * Explicit model routing. Returns the ORDERED endpoint chain for a run: the
 * requested model's endpoint first (its own model), then the OTHER endpoint as a
 * fallback (with a sensible default model for it). Only endpoints whose key is
 * configured appear — so an agent saved with a Qwen model still runs on Claude
 * when Qwen isn't configured, and every run gains a cross-endpoint fallback when
 * both are present. This is the single source of truth for run routing.
 */
export function routeModel(requested?: string, allowance: ModelAllowance = UNLIMITED_MODEL_ALLOWANCE): RouteStep[] {
  const model = requested?.trim() || DEFAULT_AGENT_MODEL
  const wantsClaude = isClaude(model)

  // A spent allowance REDIRECTS to Qwen; it never refuses. With no Qwen
  // endpoint configured there is nowhere to redirect to, so the ceilings do not
  // apply at all — otherwise an unset env var would quietly stop every run in
  // the workspace, which is a far worse failure than an unenforced cap.
  const capsApply = hasQwen()
  const claudeAllowed = !capsApply || allowance.claude
  const frontierAllowed = !capsApply || allowance.frontier
  /** Hold a Claude model to the tier this actor may still reach today. */
  const permitted = (id: string) => (frontierAllowed || modelTier(id) !== 'frontier' ? id : DOWNGRADE_CLAUDE_MODEL)

  const claudeStep: RouteStep = { target: 'claude', model: permitted(wantsClaude ? model : FALLBACK_CLAUDE_MODEL) }
  const qwenStep: RouteStep = { target: 'qwen', model: wantsClaude ? FALLBACK_QWEN_MODEL : model }
  const ordered = wantsClaude ? [claudeStep, qwenStep] : [qwenStep, claudeStep]
  // A spent whole-family allowance drops Claude from the chain entirely, not
  // just from first place: leaving it as the fallback would hand every Qwen
  // overload straight back to the endpoint the ceiling exists to relieve.
  const available = ordered.filter((step) => (step.target === 'qwen' ? hasQwen() : hasAnthropic() && claudeAllowed))
  // When Anthropic is the ONLY configured endpoint (the common deployment), a
  // transient overload (529) of the primary has nowhere to fall back and fails
  // the run immediately. Append a second Claude step on a different model so the
  // run retries there instead. No-op when the primary already IS the fallback
  // model, or when a cross-provider fallback already exists.
  if (available.length === 1 && available[0].target === 'claude' && available[0].model !== permitted(FALLBACK_CLAUDE_MODEL)) {
    available.push({ target: 'claude', model: permitted(FALLBACK_CLAUDE_MODEL) })
  }
  return available
}

function buildProvider(step: RouteStep): Provider {
  return step.target === 'qwen'
    ? new AnthropicProvider('qwen', qwenModel(step.model), qwenClient(), 'compat')
    : new AnthropicProvider('anthropic', step.model, claudeClient(), 'anthropic')
}

/**
 * Build the agent runner for the requested model: an AgentRunner over the routed
 * endpoint chain (primary + cross-endpoint fallback). Keeps the same signature
 * and ModelRunner contract as before; callers are unchanged.
 */
export function createModelRunner(requested?: string, allowance?: ModelAllowance): ModelRunner {
  const chain = routeModel(requested, allowance).map(buildProvider)
  if (chain.length === 0) {
    throw new Error('No model provider configured — set ANTHROPIC_API_KEY (or QWEN_API_KEY + QWEN_BASE_URL).')
  }
  return new AgentRunner(chain)
}

// Resolve which endpoint/model to use for a cheap "summary" call, honoring
// SUMMARY_MODEL but falling back to whichever endpoint's key is present.
function summaryTarget(): { target: 'claude' | 'qwen'; model: string } | null {
  const wantsClaude = isClaude(DEFAULT_SUMMARY_MODEL)
  if (wantsClaude && hasAnthropic()) return { target: 'claude', model: DEFAULT_SUMMARY_MODEL }
  if (!wantsClaude && hasQwen()) return { target: 'qwen', model: DEFAULT_SUMMARY_MODEL }
  if (hasAnthropic()) return { target: 'claude', model: 'claude-haiku-4-5' }
  if (hasQwen()) return { target: 'qwen', model: FALLBACK_QWEN_MODEL }
  return null
}

// Cheap one-line summary for the activity feed. Best-effort: returns null when
// no provider is configured or the call fails.
export async function generateHeadline(summary: string, ledger?: LedgerContext): Promise<string | null> {
  const target = summaryTarget()
  if (!target || !summary.trim()) return null
  const system =
    'Summarize what an AI agent run accomplished in one short, friendly past-tense line of at most 10 words. Respond with the line only — no quotes, no preamble.'
  const startedAt = Date.now()
  try {
    // Both endpoints speak the Anthropic Messages API.
    const client = target.target === 'qwen' ? qwenClient() : claudeClient()
    const response = await client.messages.create({
      model: target.target === 'qwen' ? qwenModel(target.model) : target.model,
      max_tokens: 64,
      system,
      messages: [{ role: 'user', content: summary.slice(0, 4000) }],
    })
    if (ledger) {
      void recordLlmCall({
        organizationId: ledger.organizationId,
        userId: ledger.userId ?? null,
        surface: 'headline',
        provider: target.target === 'qwen' ? 'qwen' : 'anthropic',
        model: target.model,
        usage: {
          inputTokens: response.usage.input_tokens,
          cacheWriteTokens: response.usage.cache_creation_input_tokens || 0,
          cacheReadTokens: response.usage.cache_read_input_tokens || 0,
          outputTokens: response.usage.output_tokens,
        },
        latencyMs: Date.now() - startedAt,
        agentExecutionId: ledger.agentExecutionId,
        flowRunId: ledger.flowRunId,
      })
    }
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .trim()
    return text ? text.split('\n')[0].slice(0, 120) : null
  } catch {
    return null
  }
}

/**
 * One-shot structured-output completion against a JSON schema, used by the
 * natural-language agent builder and the assistant chat. Tries the preferred
 * provider first and FALLS BACK to the other on availability failures (quota,
 * auth, overload) — a dead key on one provider must not take the feature down
 * when the other works. Throws only when every configured provider failed or
 * none is configured. Returns the raw JSON string (caller parses).
 */
type StructuredOpts = {
  system: string
  user: string
  schema: Record<string, unknown>
  schemaName: string
  maxTokens?: number
  /**
   * Optional model override for this call, e.g. a cheap tier for reflection
   * passes. Only honored on the Claude path (Qwen resolves its own model via
   * QWEN_MODEL); falls back to the existing DEFAULT_AGENT_MODEL behavior when
   * unset or when the override isn't a Claude model.
   */
  model?: string
  /** Optional cost attribution. Omitted callers are simply not recorded. */
  ledger?: LedgerContext
}

/**
 * Availability failures (retryable on the OTHER provider): quota/rate limits,
 * bad or revoked keys, and provider-side outages. Schema/validation errors are
 * ours — retrying elsewhere won't help, so they propagate immediately.
 */
export function isProviderAvailabilityError(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status
  if (typeof status !== 'number') return false
  return status === 401 || status === 403 || status === 429 || status >= 500
}

/** Endpoint order for structured calls: honor the default model's endpoint, try the other second. */
export function structuredProviderOrder(input: {
  defaultModel: string
  qwen: boolean
  anthropic: boolean
}): Array<'claude' | 'qwen'> {
  const wantsClaude = input.defaultModel.startsWith('claude')
  const order: Array<'claude' | 'qwen'> = wantsClaude ? ['claude', 'qwen'] : ['qwen', 'claude']
  return order.filter((target) => (target === 'qwen' ? input.qwen : input.anthropic))
}

/**
 * Anthropic structured outputs require every object schema to close
 * additionalProperties. Deep-normalize: any {type:'object'} WITH properties
 * gains additionalProperties:false (unless explicitly set); recurses through
 * properties/items/anyOf/oneOf/allOf/definitions/$defs.
 *
 * A {type:'object'} WITHOUT properties (free-form) is left untouched — strict
 * mode cannot express a free-form object at all, so forcing
 * additionalProperties:false there would collapse it to an empty object.
 */
export function strictifySchema(schema: Record<string, unknown>): Record<string, unknown> {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit)
    if (!node || typeof node !== 'object') return node
    const out: Record<string, unknown> = { ...(node as Record<string, unknown>) }
    if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
      if (out.additionalProperties === undefined) out.additionalProperties = false
      out.properties = Object.fromEntries(
        Object.entries(out.properties as Record<string, unknown>).map(([key, value]) => [key, visit(value)]),
      )
    }
    for (const key of ['items', 'anyOf', 'oneOf', 'allOf'] as const) {
      if (out[key] !== undefined) out[key] = visit(out[key])
    }
    for (const key of ['definitions', '$defs'] as const) {
      if (out[key] && typeof out[key] === 'object') {
        out[key] = Object.fromEntries(Object.entries(out[key] as Record<string, unknown>).map(([k, v]) => [k, visit(v)]))
      }
    }
    return out
  }
  return visit(schema) as Record<string, unknown>
}

/**
 * The compat dialect's stand-in for `output_config`.
 *
 * Appended to the SYSTEM prompt, not the user message, deliberately: it then
 * sits with GUARDRAIL_RULE and the untrusted-data fencing, on the same side of
 * the trust boundary, so fenced content can't argue with the output contract
 * any more than it can argue with the guardrails.
 */
export function schemaInstruction(schemaName: string, schema: Record<string, unknown>): string {
  return [
    `Output format — reply with a single JSON value named "${schemaName}" that validates against this JSON Schema:`,
    JSON.stringify(schema),
    'Reply with that JSON and nothing else: no prose before or after it, no markdown code fence, no explanation. Every required property must be present.',
  ].join('\n')
}

/**
 * Recover the JSON value from a compat reply.
 *
 * The compat dialect has no schema constraint — only the instruction above — so
 * a model on it sometimes wraps the object in a ```json fence or tops it with a
 * sentence. Strips a fence when present, then takes the outermost {...}/[...]
 * span. A clean reply passes through untouched, and a genuinely broken one is
 * returned as-is so the caller's JSON.parse fails with the model's own text to
 * debug from rather than an empty string.
 */
export function extractJson(text: string): string {
  const trimmed = text.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)
  const body = (fenced ? fenced[1] : trimmed).trim()
  const start = body.search(/[{[]/)
  if (start === -1) return body
  const end = body.lastIndexOf(body[start] === '{' ? '}' : ']')
  return end > start ? body.slice(start, end + 1) : body
}

/**
 * Shape one structured call for a dialect. Exported for the same reason as
 * buildMessagesRequest: on compat both the guardrails AND the output contract
 * ride in the system string, and nothing in a response proves they were sent.
 */
export function buildStructuredRequest(input: {
  system: string
  user: string
  schema: Record<string, unknown>
  schemaName: string
  model: string
  maxTokens?: number
  dialect: WireDialect
}): Anthropic.MessageCreateParamsNonStreaming {
  const schema = strictifySchema(input.schema)
  const full = input.dialect === 'anthropic'
  return {
    model: input.model,
    max_tokens: input.maxTokens ?? 4096,
    // Compat cannot be handed `output_config`, so the schema is instructed
    // instead — appended AFTER the caller's system prompt so the guardrails
    // it carries stay first and stay intact.
    system: full ? input.system : `${input.system}\n\n${schemaInstruction(input.schemaName, schema)}`,
    messages: [{ role: 'user', content: input.user }],
    ...(full ? { output_config: { format: { type: 'json_schema' as const, schema } } } : {}),
  }
}

/**
 * One structured call over the Anthropic Messages API (both Claude and Qwen
 * speak it). Claude gets an `output_config` json_schema constraint; Qwen's
 * compat endpoint gets the instructed equivalent and its reply is unwrapped.
 */
async function anthropicWireStructured(
  opts: StructuredOpts,
  client: Anthropic,
  model: string,
  provider: 'anthropic' | 'qwen',
  dialect: WireDialect,
): Promise<string> {
  const startedAt = Date.now()
  const response = await client.messages.create(
    buildStructuredRequest({
      system: opts.system,
      user: opts.user,
      schema: opts.schema,
      schemaName: opts.schemaName,
      model,
      maxTokens: opts.maxTokens,
      dialect,
    }),
  )
  if (opts.ledger) {
    void recordLlmCall({
      organizationId: opts.ledger.organizationId,
      userId: opts.ledger.userId ?? null,
      surface: opts.ledger.surface ?? 'structured',
      provider,
      model,
      usage: {
        inputTokens: response.usage.input_tokens,
        cacheWriteTokens: response.usage.cache_creation_input_tokens || 0,
        cacheReadTokens: response.usage.cache_read_input_tokens || 0,
        outputTokens: response.usage.output_tokens,
      },
      latencyMs: Date.now() - startedAt,
      agentExecutionId: opts.ledger.agentExecutionId,
      flowRunId: opts.ledger.flowRunId,
    })
  }
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
  return dialect === 'anthropic' ? text : extractJson(text)
}

/**
 * Record what personal data a structured call is about to carry, for every
 * caller of generateStructured at once.
 *
 * The interactive endpoints (both copilots, code-assist, the AI searches, the
 * huddle summariser, agent draft, agent chat) all gate on assertAiCallAllowed
 * and none of them recorded — so the compliance answer "which categories of PII
 * went to which processor" covered agent and flow runs and silently omitted
 * every prompt a person typed. Recording HERE rather than at each endpoint is
 * the same reasoning as the fencing helper: the eleventh endpoint gets it by
 * calling the shared function, not by remembering.
 *
 * The tenant comes from the ledger context when the caller threaded one, and
 * otherwise from the ambient organization that withAuthenticatedApi establishes
 * for the whole request (see lib/server/api-handler.ts). Callers with neither —
 * scripts, the dev eval harness — are not recorded, exactly as they are not
 * metered. Only the user message is scanned: the system prompt is our own text,
 * and scanning it would report the platform's own words as customer PII.
 */
function recordStructuredEgress(opts: StructuredOpts): void {
  const organizationId = opts.ledger?.organizationId ?? ambientOrganization.getStore()
  if (!organizationId) return
  void recordPiiEgress({
    organizationId,
    userId: opts.ledger?.userId ?? null,
    // schemaName identifies the endpoint far better than 'structured' does —
    // 'flow_edit_ops' and 'huddle_note' are different processors of PII.
    surface: `llm.structured:${opts.schemaName}`,
    text: opts.user,
  })
}

export async function generateStructured(opts: StructuredOpts): Promise<string> {
  recordStructuredEgress(opts)
  const overrideModel = opts.model?.trim() || undefined
  const effectiveDefaultModel = overrideModel || DEFAULT_AGENT_MODEL
  const order = structuredProviderOrder({
    defaultModel: effectiveDefaultModel,
    qwen: hasQwen(),
    anthropic: hasAnthropic(),
  })
  if (order.length === 0) {
    throw new Error('No model provider configured — set ANTHROPIC_API_KEY (or QWEN_API_KEY + QWEN_BASE_URL).')
  }

  // The override only threads onto the Claude path — Qwen resolves its own
  // model via QWEN_MODEL, so an unusable (non-Claude) override falls back to
  // the pre-existing DEFAULT_AGENT_MODEL selection unchanged.
  const claudeModel = overrideModel && isClaude(overrideModel) ? overrideModel : isClaude(DEFAULT_AGENT_MODEL) ? DEFAULT_AGENT_MODEL : FALLBACK_CLAUDE_MODEL

  let lastError: unknown
  for (const target of order) {
    try {
      return target === 'qwen'
        ? await anthropicWireStructured(opts, qwenClient(), qwenModel(FALLBACK_QWEN_MODEL), 'qwen', 'compat')
        : await anthropicWireStructured(opts, claudeClient(), claudeModel, 'anthropic', 'anthropic')
    } catch (error) {
      lastError = error
      if (!isProviderAvailabilityError(error)) throw error
      apiLogger.warn('generateStructured: endpoint unavailable, trying fallback', {
        target,
        status: (error as { status?: number }).status,
        error: error instanceof Error ? error.message.slice(0, 200) : String(error),
      })
    }
  }
  throw lastError
}

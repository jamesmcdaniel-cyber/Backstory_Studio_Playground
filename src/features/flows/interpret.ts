import type { FlowGraph, FlowNode, FlowEdge, VariableType, PerItemConfig } from '@/lib/flows/graph'
import { resolveTemplate, resolveTemplateValue, asStructured, evalCondition, evalClause, normalizeStepAlias, buildUpstreamContextBlock, type FlowContext } from './context'
import { stepLabelsOf } from '@/lib/flows/token-text'
import { buildAdjacency, edgeActivationsFor, type EdgeState, type EdgeResult, type NodeRunState } from '@/lib/flows/dag-scheduler'
import { shouldRetryAfterTimeout } from './action-reliability'
import { structuredResponseInstruction, parseStructuredAgentOutput } from './agent-response'
import { runDataOp, chunkItems, coerceFieldType } from '@/lib/flows/data-ops'
import { mergeAppend, mergeAllCombinations, mergeByKey, mergeByPosition } from '@/lib/flows/merge'
import { computeResumeAt } from '@/lib/flows/wait'
import { foreignReferences, unresolvedAuthHeaders, foreignReferenceMessage, unresolvedAuthMessage } from '@/lib/flows/foreign-reference'

export type StepOutcome = {
  nodeId: string
  // The persistence key: `${nodeId}${indexKey}` — inside a loop it carries the
  // iteration suffix (e.g. `agent#1`) so every iteration's step row is distinct;
  // on the main chain it equals `nodeId`. `nodeId` stays bare (for
  // {{step.<id>.output}} and onStep node-type lookups); callers that persist
  // rows / build the resume `completed` map key by `iterationKey`.
  iterationKey?: string
  status: 'succeeded' | 'failed' | 'skipped' | 'waiting' | 'stopped'
  /**
   * The RESOLVED input the node actually evaluated (operands after template
   * resolution, the record a transform mapped, the list a loop iterated).
   * Persisted onto the step row so the run panel shows real I/O instead of
   * the schema-default `{}`. Adapter-persisted types record their own input.
   */
  input?: unknown
  output?: unknown
  error?: string
  /**
   * Degraded-success notes: the step succeeded, but something the user would
   * want to know about happened along the way — items dropped by an itemError
   * policy, an empty result where data was expected. Persisted per step row;
   * a succeeded run with any step warnings renders as degraded in the UI.
   */
  warnings?: string[]
}
export type RunAgentResult = { output?: unknown; error?: string; waiting?: { status: string; question?: string } }
/** Per-step agent configuration (n8n-style sub-node parity): a chat-model
 * override, conversation memory for this step's runs (sessionKey already
 * template-resolved), and extra tool connections granted for the run. */
export type AgentStepOverrides = {
  model?: string
  memory?: { store: 'postgres' | 'redis' | 'mongodb' | 'xata'; sessionKey: string; window?: number }
  toolConnectionIds?: string[]
}
export type RunAgentFn = (node: {
  id: string
  agentId: string
  input: string
  resume?: boolean
  overrides?: AgentStepOverrides
}) => Promise<RunAgentResult>
// Deterministic (non-agent) steps: tool calls, HTTP requests, and single-turn
// AI ops (ask/extract/categorize/summarize/score). `config` arrives with every
// templated field already resolved against the flow context — for 'ai' that's
// just `input`/`instructions`; the op's other fields (aiOp, model, categories,
// outputFields, score bounds, retries, timeoutMs) are statics the interpreter
// passes through unresolved, same as tool/http's retries/timeoutMs.
// `resume` marks the node a paused run is re-entering (e.g. after an approval
// decision) so the adapter can consume the decision instead of re-executing.
export type RunActionFn = (node: { id: string; kind: 'tool' | 'http' | 'ai' | 'subflow' | 'knowledge' | 'code'; config: Record<string, unknown>; resume?: boolean }) => Promise<RunAgentResult>
export type InterpretResult = {
  status: 'succeeded' | 'failed' | 'waiting'
  steps: StepOutcome[]
  output: unknown
  // `resumeAt` (ISO) marks a wait node's timer pause — the run should resume at
  // that wall-clock time (a cron scan wakes it). `waitKind` distinguishes a
  // timer pause from a webhook-callback pause. Absent for agent/approval/review
  // pauses, which resume on a human reply.
  waiting?: { nodeId: string; question?: string; resumeAt?: string; waitKind?: 'timer' | 'webhook' }
  // Why a failed run failed — the failing node's error (e.g. the timeout
  // message) so callers can persist it on the run record.
  error?: string
  // Named flow outputs collected from every `output` node that ran (later names
  // merge/override earlier). Undefined when no output node ran — callers then
  // fall back to `output` (the last-step value) for full back-compat.
  namedOutputs?: Record<string, unknown>
}

/** Thrown by the scheduler when isCancelled() reports the run was cancelled. */
export class FlowCancelledError extends Error {
  constructor() {
    super('Flow run cancelled')
    this.name = 'FlowCancelledError'
  }
}

type Opts = {
  runAgent: RunAgentFn
  runAction?: RunActionFn
  maxSteps?: number
  maxLoopIterations?: number
  onStep?: (outcome: StepOutcome) => void
  // Cooperative cancellation: polled once per scheduler tick (the caller
  // throttles the DB read). Returning true throws FlowCancelledError, which the
  // caller terminalizes as 'cancelled'. In-flight nodes are left to settle.
  isCancelled?: () => boolean | Promise<boolean>
  // Resume support: `completed` maps node ids already finished on a prior run to
  // their output (they are skipped, not re-run); `resumeNodeId` is the node that
  // was paused and should re-run with the user's reply injected.
  completed?: Record<string, unknown>
  // Step keys in `completed` that FAILED with onError:'route' on the prior
  // attempt: replay must follow the node's error edge again (the completed
  // map alone can't express which edge the walk took).
  completedRoutes?: Set<string>
  resumeNodeId?: string
  // The user's reply for the resuming node. Agent steps receive the reply
  // inside their adapter (execute-flow re-enters the paused execution with
  // it); a humanReview step has no adapter, so the interpreter itself turns
  // this reply into the resuming step's output.
  resumeReply?: string
  // Context tokens: the run's frozen clock (`{{now}}`) and run/flow metadata
  // (`{{run.*}}`/`{{flow.*}}`), injected by execute-flow and threaded into the
  // ctx (and every loop/parallel sub-context) so they resolve everywhere.
  now?: { iso: string; date: string; time: string; unix: number }
  run?: { id: string; url: string; resumeUrl?: string; trigger: string; startedAt: string; flowId: string; flowName: string }
  // Node-id → display-label map (as the builder shows them). Used to resolve
  // hand-typed friendly-label tokens like `{{Previous Agent.output}}` to the
  // right step. Defaults to labels derivable from the graph alone; callers
  // that know agent titles (execute-flow) pass richer labels.
  stepLabels?: Record<string, string>
  // Partial execution for the node editor's step controls:
  //   stopAfterNodeId  — run through this node, then end the run ("Execute step").
  //   stopBeforeNodeId — run everything up to this node but not the node itself,
  //                      so its input is produced ("Execute previous nodes").
  stopAfterNodeId?: string
  stopBeforeNodeId?: string
}

// Result of executing a single node — an output, or a control signal that
// propagates up through containers and halts the main chain.
type NodeResult =
  | { kind: 'ok'; output: unknown }
  | { kind: 'skip' }
  | { kind: 'stop' }
  | { kind: 'fail'; error: string }
  | { kind: 'pause'; nodeId: string; question?: string; resumeAt?: string; waitKind?: 'timer' | 'webhook' }
  // A filter that didn't pass: drops the current loop item, or ends the main chain.
  | { kind: 'drop' }
  // A step with onError:'route' that FAILED — its output is the `{ error, input }`
  // pass-through object, and the main-chain walk follows the node's labeled
  // 'error' edge (Error Shield). Inside a container body (no branch edges) this
  // is treated like 'continue': the body threads the error object and proceeds.
  | { kind: 'route'; output: unknown }
  // A condition/switch decision — the scheduler activates the matching branch
  // edge and deads the rest. `output` mirrors the recorded outcome value.
  | { kind: 'branch'; branch: string | string[]; output: unknown }

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// Independent ready nodes run concurrently up to this bound. Matches the
// loop-node default; variable writes across concurrent branches are unordered.
const MAX_CONCURRENT_NODES = 8

// Sentinel a timed-out race resolves to — distinguishable from a RunAgentResult
// that happens to carry an error.
const TIMED_OUT = Symbol('flow-step-timed-out')

/** Race `promise` against a deadline; the timer is cleared either way. */
const raceTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const width = Math.max(1, Math.min(limit, items.length))
  const workers = Array.from({ length: width }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/** Convert common run-input shapes into a loopable list. */
function loopItems(value: unknown): unknown[] {
  const structured = asStructured(value)
  if (Array.isArray(structured)) return structured
  if (structured && typeof structured === 'object') {
    for (const key of ['items', 'records', 'results', 'result', 'data']) {
      const candidate = (structured as Record<string, unknown>)[key]
      if (Array.isArray(candidate)) return candidate
    }
    return []
  }
  if (typeof structured !== 'string') return []
  const trimmed = structured.trim()
  if (!trimmed) return []
  const lines = trimmed.split(/\r?\n/).map((part) => part.trim()).filter(Boolean)
  if (lines.length > 1) return lines
  const commaParts = trimmed.split(',').map((part) => part.trim()).filter(Boolean)
  if (commaParts.length > 1) return commaParts
  return [trimmed]
}

/** The per-item fan-out config a node carries, if any (only action nodes do). */
function nodePerItem(node: FlowNode): PerItemConfig | undefined {
  return 'perItem' in node.data ? (node.data as { perItem?: PerItemConfig }).perItem : undefined
}

// ── Step warnings: degraded success made visible ────────────────────────────

const LOOPABLE_KEYS = ['items', 'records', 'results', 'result', 'data']

/**
 * A data-producing step that succeeded with nothing in it — the silent-empty
 * failure mode (typically a masked upstream stub or a filter that matched
 * nothing). Flags an empty array, or a record whose list-shaped keys are all
 * present-but-empty ({items: [], total: 0}). A record with no list keys is
 * left alone — plain command responses ({ok: true}) aren't "no items".
 */
function emptyResultWarning(output: unknown): string | undefined {
  const message = 'This step succeeded but returned no items.'
  if (Array.isArray(output)) return output.length === 0 ? message : undefined
  if (output && typeof output === 'object') {
    const record = output as Record<string, unknown>
    const listKeys = LOOPABLE_KEYS.filter((key) => Array.isArray(record[key]))
    if (listKeys.length && listKeys.every((key) => (record[key] as unknown[]).length === 0)) return message
  }
  return undefined
}

/** Warning for items dropped or error-collected by an itemError policy. */
function itemPolicyWarning(policy: 'fail' | 'skip' | 'collect', failed: number, total: number): string | undefined {
  if (failed === 0 || policy === 'fail') return undefined
  const verb = policy === 'skip'
    ? failed === 1 ? 'was skipped' : 'were skipped'
    : failed === 1 ? 'was recorded as an error' : 'were recorded as errors'
  return `${failed} of ${total} items failed and ${verb}.`
}

// ── Variable steps: a typed symbol table shared across the whole run ────────

const VARIABLE_DEFAULTS: Record<VariableType, () => unknown> = {
  boolean: () => false,
  integer: () => 0,
  float: () => 0,
  string: () => '',
  object: () => ({}),
  array: () => [],
}

const asText = (value: unknown): string => (typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value))

const safeJson = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/** The type family a variable's current runtime value belongs to. */
function runtimeTypeOf(value: unknown): VariableType {
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'float'
  if (Array.isArray(value)) return 'array'
  if (value && typeof value === 'object') return 'object'
  return 'string'
}

/** Coerce a resolved value to a variable type. Blank values take the type's default. */
function coerceVariableValue(name: string, varType: VariableType, resolved: unknown): { value: unknown } | { error: string } {
  const text = typeof resolved === 'string' ? resolved.trim() : undefined
  if (resolved === undefined || text === '') return { value: VARIABLE_DEFAULTS[varType]() }
  switch (varType) {
    case 'boolean': {
      if (typeof resolved === 'boolean') return { value: resolved }
      if (text?.toLowerCase() === 'true') return { value: true }
      if (text?.toLowerCase() === 'false') return { value: false }
      return { error: `Variable "${name}" needs true or false — "${asText(resolved)}" isn't either.` }
    }
    case 'integer': {
      const n = typeof resolved === 'number' ? resolved : Number(text)
      if (Number.isInteger(n)) return { value: n }
      return { error: `Variable "${name}" needs a whole number — "${asText(resolved)}" isn't one.` }
    }
    case 'float': {
      const n = typeof resolved === 'number' ? resolved : Number(text)
      if (Number.isFinite(n)) return { value: n }
      return { error: `Variable "${name}" needs a number — "${asText(resolved)}" isn't one.` }
    }
    case 'string':
      return { value: typeof resolved === 'string' ? resolved : asText(resolved) }
    case 'object': {
      const parsed = typeof resolved === 'string' ? safeJson(text ?? '') : resolved
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { value: parsed }
      return { error: `Variable "${name}" needs a JSON object value.` }
    }
    case 'array': {
      const parsed = typeof resolved === 'string' ? safeJson(text ?? '') : resolved
      if (Array.isArray(parsed)) return { value: parsed }
      return { error: `Variable "${name}" needs a JSON array value.` }
    }
  }
}

/**
 * Apply one variable step to the run's symbol table. Initialize coerces to the
 * declared type; set/increment coerce against the DECLARED type from the
 * variable's initialize node (so a float var stays float even while its current
 * value happens to be whole), falling back to the current value's runtime
 * family only when no initialize node exists; increment/decrement take an
 * optional templated amount (default 1); appends require the matching
 * array/string shape. Returns the variable's new value — the step's output —
 * or a plain-english error.
 */
function applyVariableOp(
  node: Extract<FlowNode, { type: 'variable' }>,
  ctx: FlowContext,
  declaredTypes: ReadonlyMap<string, VariableType>,
): { output: unknown } | { error: string } {
  const variables = (ctx.variables ??= {})
  const name = node.data.name.trim()
  if (!name) return { error: 'This variable step needs a name.' }
  if (node.data.op === 'initialize') {
    const resolved = node.data.value?.trim() ? resolveTemplateValue(node.data.value, ctx) : undefined
    const coerced = coerceVariableValue(name, node.data.varType ?? 'string', resolved)
    if ('error' in coerced) return coerced
    variables[name] = coerced.value
    return { output: coerced.value }
  }
  if (!Object.prototype.hasOwnProperty.call(variables, name)) {
    return { error: `Variable "${name}" hasn't been initialized yet.` }
  }
  const current = variables[name]
  const declared = declaredTypes.get(name) ?? runtimeTypeOf(current)
  if (node.data.op === 'set') {
    const raw = node.data.value ?? ''
    const resolved = resolveTemplateValue(raw, ctx)
    // A configured value (e.g. a token) that resolves to nothing is a broken
    // reference — fail instead of silently resetting to the type default. A
    // raw-empty field stays a legitimate "set to the default" (empty string,
    // empty object/array).
    const blank = resolved === undefined || (typeof resolved === 'string' && resolved.trim() === '')
    if (blank && raw.trim()) return { error: `Variable "${name}" needs a value — the value came back empty.` }
    const coerced = coerceVariableValue(name, declared, resolved)
    if ('error' in coerced) return coerced
    variables[name] = coerced.value
    return { output: coerced.value }
  }
  if (node.data.op === 'increment' || node.data.op === 'decrement') {
    const verb = node.data.op === 'increment' ? 'incremented' : 'decremented'
    if (typeof current !== 'number') return { error: `Variable "${name}" isn't a number, so it can't be ${verb}.` }
    let amount = 1
    if (node.data.value?.trim()) {
      const resolvedAmount = resolveTemplate(node.data.value, ctx).trim()
      // Number('') is 0 — a broken token amount must fail, not silently no-op.
      if (!resolvedAmount) return { error: `Variable "${name}" needs a number for the amount — the value came back empty.` }
      amount = Number(resolvedAmount)
      if (!Number.isFinite(amount)) return { error: `Variable "${name}" needs a number amount — "${resolvedAmount}" isn't one.` }
      if (declared === 'integer' && !Number.isInteger(amount)) {
        return { error: `Variable "${name}" needs a whole number amount — "${resolvedAmount}" isn't one.` }
      }
    }
    const next = node.data.op === 'increment' ? current + amount : current - amount
    variables[name] = next
    return { output: next }
  }
  if (node.data.op === 'appendArray') {
    if (!Array.isArray(current)) return { error: `Variable "${name}" isn't an array, so nothing can be appended.` }
    const next = [...current, resolveTemplateValue(node.data.value ?? '', ctx)]
    variables[name] = next
    return { output: next }
  }
  // appendString
  if (typeof current !== 'string') return { error: `Variable "${name}" isn't text, so nothing can be appended.` }
  const next = current + resolveTemplate(node.data.value ?? '', ctx)
  variables[name] = next
  return { output: next }
}

function resolveConfigValue(value: string | undefined, ctx: FlowContext, onMissing?: (path: string) => void): unknown {
  if (!value?.trim()) return undefined
  try {
    return resolveTemplateValue(JSON.parse(value), ctx, onMissing)
  } catch {
    return resolveTemplateValue(value, ctx, onMissing)
  }
}

/**
 * Deterministically interpret a flow graph. Pure: agent execution is delegated
 * to `opts.runAgent`. Supports nested control flow (loops/parallels containing
 * containers), container-level fail/pause propagation, a stop node, retries,
 * per-step timeout, and full per-node outcome reporting via `opts.onStep`.
 */
export async function interpretFlow(graph: FlowGraph, input: unknown, opts: Opts): Promise<InterpretResult> {
  const maxSteps = opts.maxSteps ?? 100
  const maxLoop = opts.maxLoopIterations ?? 500
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  // Source node ids feeding each node, in edge order — used by a merge-mode join
  // to gather every active incoming branch's output.
  const incomingSources = new Map<string, string[]>()
  for (const edge of graph.edges) {
    const list = incomingSources.get(edge.target) ?? []
    list.push(edge.source)
    incomingSources.set(edge.target, list)
  }
  // Declared variable types: each name's initialize node (anywhere in the
  // graph, container bodies included) governs how later set/increment values
  // are coerced.
  const declaredTypes = new Map<string, VariableType>()
  for (const node of graph.nodes) {
    if (node.type !== 'variable' || node.data.op !== 'initialize') continue
    const name = node.data.name.trim()
    if (name && !declaredTypes.has(name)) declaredTypes.set(name, node.data.varType ?? 'string')
  }
  const steps: StepOutcome[] = []
  const emitOutcome = (outcome: StepOutcome) => {
    steps.push(outcome)
    opts.onStep?.(outcome)
  }
  // Run-level named-output collector: populated the moment any `output` node
  // runs (main chain or container body). Stays undefined otherwise so callers
  // keep the last-step-output back-compat behavior.
  let namedOutputs: Record<string, unknown> | undefined
  let visits = 0
  const overBudget = () => ++visits > maxSteps

  // Run an agent with optional per-attempt timeout and retry-with-backoff.
  const runAgentWithReliability = async (
    node: Extract<FlowNode, { type: 'agent' }>,
    resolvedInput: string,
    stepKey: string,
    overrides?: AgentStepOverrides,
  ): Promise<RunAgentResult> => {
    const retries = node.data.retries ?? 0
    const timeoutMs = node.data.timeoutMs
    const resume = opts.resumeNodeId === stepKey
    let attempt = 0
    for (;;) {
      const call = opts.runAgent({ id: stepKey, agentId: node.data.agentId, input: resolvedInput, resume, ...(overrides ? { overrides } : {}) })
      const raced = timeoutMs ? await raceTimeout(call, timeoutMs) : await call
      // A timeout only ABANDONS the live agent execution — Promise.race cannot
      // cancel it, so it may still be running (and spending tokens / performing
      // side effects). Retrying would start a SECOND concurrent execution, so
      // the shared policy (shouldRetryAfterTimeout) keeps agent timeouts
      // terminal; `retries` still applies to hard errors below.
      if (raced === TIMED_OUT) {
        const error = `Timed out after ${Math.round((timeoutMs ?? 0) / 1000)}s — the agent may still be finishing in the background.`
        if (!shouldRetryAfterTimeout('agent') || attempt >= retries) return { error }
        attempt += 1
        await sleep(Math.min(8000, 250 * 2 ** attempt))
        continue
      }
      const res = raced
      // Retry only hard errors (never a waiting/paused result).
      if (!res.error || res.waiting || attempt >= retries) return res
      attempt += 1
      await sleep(Math.min(8000, 250 * 2 ** attempt))
    }
  }

  // Execute one node against `ctx`. Never routes edges (the main-chain walker
  // and container bodies drive traversal); returns an output or control signal.
  // `perItemChild` is set on the recursive per-item calls so they run the node's
  // ordinary single-item path instead of re-entering the fan-out.
  const execNode = async (node: FlowNode, ctx: FlowContext, indexKey = '', perItemChild = false): Promise<NodeResult> => {
    if (overBudget()) return { kind: 'fail', error: 'Flow exceeded the maximum number of steps.' }

    // Per-iteration keying: inside a loop `indexKey` is `#<index>` (nested loops
    // append, e.g. `#0#2`), so each iteration persists/looks-up its step under a
    // distinct `stepKey` while the in-memory `ctx.step[node.id]` stays bare for
    // {{step.<id>.output}} resolution. On the main chain `indexKey` is '' and
    // `stepKey === node.id` — byte-identical to before. `emit` reports the bare
    // node id but tags each outcome with `iterationKey` for the persistence layer.
    const stepKey = node.id + indexKey
    const emit = (outcome: StepOutcome) => emitOutcome({ ...outcome, iterationKey: stepKey })

    // Resolved comparison operands for condition/filter capture — handles both
    // the multi-clause shape and the legacy single left/op/right.
    const resolvedClauseInput = (data: { clauses?: { left: string; op: string; right: string }[]; left?: string; op?: string; right?: string }) => {
      const list = data.clauses?.length
        ? data.clauses
        : data.left !== undefined
          ? [{ left: data.left, op: data.op ?? 'equals', right: data.right ?? '' }]
          : []
      return { clauses: list.map((c) => ({ left: resolveTemplate(c.left, ctx), op: c.op, right: resolveTemplate(c.right, ctx) })) }
    }

    // Shared failure disposition for a step that carries an `onError` policy
    // (agent/tool/http). 'stop' → fail the run; 'continue' → swallow the error
    // and proceed with no output; 'route' → the output becomes a pass-through
    // `{ error, input }` object and the main walk follows the labeled 'error'
    // edge (or, with none, continues down the normal edge — the walk decides).
    // `resolvedInput` is the step's already-resolved input, surfaced so a
    // downstream handler can read `{{step.<id>.output.input}}`.
    const onFailure = (mode: 'stop' | 'continue' | 'route', error: string, resolvedInput: unknown): NodeResult => {
      if (mode === 'route') {
        const output = { error, input: resolvedInput }
        ctx.step[node.id] = { output }
        return { kind: 'route', output }
      }
      if (mode === 'continue') return { kind: 'ok', output: undefined }
      return { kind: 'fail', error }
    }

    // Broken data references (a token whose root is no step id, step label, or
    // context key — see resolveContextPath) must fail the step with the exact
    // token named, never silently substitute empty text into a message, HTTP
    // call, or agent prompt. Collected per adapter-step resolution below.
    const missingTokens = new Set<string>()
    const onMissingToken = (path: string) => missingTokens.add(path)
    const failStep = (error: string, resolvedInput: unknown): NodeResult => {
      const mode = 'onError' in node.data ? ((node.data as { onError?: 'stop' | 'continue' | 'route' }).onError ?? 'stop') : 'stop'
      // `input` rides on the outcome so the persistence layer can record a
      // step row for a step that failed BEFORE its adapter ran (resolution
      // failures) — otherwise the run fails with no step naming the culprit.
      emit({ nodeId: node.id, status: 'failed', error, input: resolvedInput, ...(mode === 'route' || mode === 'continue' ? { output: { error, input: resolvedInput } } : {}) })
      return onFailure(mode, error, resolvedInput)
    }
    // How the run-level error refers to this step. The canvas shows labels, so
    // the label is what the user can actually find; ids are the last resort.
    const stepDisplayName = () => {
      const data = node.data as { label?: string; toolName?: string }
      return data.label?.trim() || data.toolName?.trim() || node.id
    }
    const missingTokenFailure = (resolvedInput: unknown): NodeResult | null => {
      if (!missingTokens.size) return null
      const list = [...missingTokens].map((p) => `{{${p}}}`).join(', ')
      return failStep(
        `Unknown data reference ${list} in step "${stepDisplayName()}" — this flow has no step or input with that name. Open that step's settings and pick the value from the data menu instead of typing it.`,
        resolvedInput,
      )
    }

    /**
     * The counterpart to missingTokenFailure: a reference this engine never
     * even recognized as a token. `{{path}}` is the only syntax resolveTemplate
     * substitutes, so another tool's placeholder (`{Output}`,
     * `body('Step')?['field']`) survives resolution as literal text and would
     * be sent to the live API verbatim — posting that string as a credential
     * and coming back 401 while every step reported success. Fail here with the
     * offending text named instead.
     */
    const unresolvedReferenceFailure = (config: Record<string, unknown>): NodeResult | null => {
      const authHeaders = unresolvedAuthHeaders(config.headers)
      if (authHeaders.length) return failStep(unresolvedAuthMessage(authHeaders), config)
      // `body` is exempt: it is payload bound for another system, which may
      // legitimately contain that system's own expression syntax (posting a
      // Logic Apps definition, say). Addressing and auth never legitimately do.
      const addressing = Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'body'))
      const foreign = foreignReferences(addressing)
      if (foreign.length) return failStep(foreignReferenceMessage(foreign), config)
      return null
    }

    if (node.type === 'trigger') return { kind: 'skip' }

    // A note is a pure annotation — never executes; the walk passes through it
    // (no step row emitted) so downstream steps still run.
    if (node.type === 'note') return { kind: 'ok', output: undefined }

    // Disabled step: skip it as a passthrough so the prior value flows on and the
    // normal edge still activates. Not honored for condition/switch — a
    // multi-output node can't passthrough to a single edge (the editor hides the
    // toggle for them), so a hand-authored disabled branch node runs normally.
    if (node.disabled && node.type !== 'condition' && node.type !== 'switch') {
      emit({ nodeId: node.id, status: 'skipped' })
      return { kind: 'ok', output: undefined }
    }

    // Resume: a node finished on the prior run is reused, not re-executed.
    // Variable state was already reconstructed by the pre-walk replay (which
    // covers container bodies the walk never enters), so a replayed variable
    // step must NOT re-apply here — that would rewind the symbol table to a
    // value from before a later completed write.
    if (opts.completed && Object.prototype.hasOwnProperty.call(opts.completed, stepKey)) {
      const output = opts.completed[stepKey]
      // A completed FILTER must replay its gate decision, not a plain 'ok': a
      // filter that dropped (`output === false`) re-drops so its downstream
      // stays dead on resume; one that passed re-passes. Otherwise the scheduler
      // would read the replay as a normal step and revive the dropped path.
      if (node.type === 'filter') {
        emit({ nodeId: node.id, status: output ? 'succeeded' : 'skipped', output })
        return output ? { kind: 'ok', output: undefined } : { kind: 'drop' }
      }
      ctx.step[node.id] = { output }
      emit({ nodeId: node.id, status: 'skipped', output })
      // A completed condition/switch must replay as the SAME branch it took, not
      // a plain 'ok' (which the scheduler would read as "fan out to all edges").
      // The recorded output IS the branch (boolean for condition, case id for
      // switch), so reconstruct it without re-evaluating.
      if (node.type === 'condition') return { kind: 'branch', branch: output ? 'true' : 'false', output }
      if (node.type === 'switch') return { kind: 'branch', branch: String(output), output }
      // A route-failed step re-takes its error edge on replay — returning ok
      // here would silently divert the resumed run down the normal path.
      if (opts.completedRoutes?.has(stepKey)) return { kind: 'route', output }
      return { kind: 'ok', output }
    }

    // ── Per-item fan-out ─────────────────────────────────────────────────────
    // A step marked `perItem` runs its ordinary action once per item of the
    // `over` list (each child keyed `#<index>`, like a loop body), collecting the
    // outputs into an array. `itemError` decides a failing item's fate; pause /
    // stop signals propagate immediately (per-item approvals, human review).
    const perItem = perItemChild ? undefined : nodePerItem(node)
    if (perItem) {
      const overValue = resolveTemplate(perItem.over, ctx, onMissingToken)
      let items = loopItems(overValue).slice(0, maxLoop)
      // n8n parity: per-item over a SINGLE object is one iteration, not zero.
      // loopItems finds no list inside a plain object — but an upstream that
      // usually fans out can legitimately produce one record, and n8n runs the
      // step once for it. An object whose list key is a present-but-empty
      // array stays zero iterations.
      const structuredOver = asStructured(overValue)
      if (
        items.length === 0 &&
        structuredOver &&
        typeof structuredOver === 'object' &&
        !Array.isArray(structuredOver) &&
        !['items', 'records', 'results', 'result', 'data'].some((key) => Array.isArray((structuredOver as Record<string, unknown>)[key]))
      ) {
        items = [structuredOver]
      }
      const broken = missingTokenFailure({ over: perItem.over })
      if (broken) return broken
      const policy = perItem.itemError ?? 'fail'
      const childResults = await mapLimit(items, perItem.concurrency ?? 1, (item, index) => {
        // Inside a per-item fan-out the incoming data IS the current item —
        // {{input}} and {{item}} agree, matching what an imported $json meant.
        const itemCtx: FlowContext = { ...ctx, item, incoming: item, step: { ...ctx.step }, loop: { index, count: items.length } }
        return execNode(node, itemCtx, `${indexKey}#${index}`, true)
      })
      const outputs: unknown[] = []
      let control: NodeResult | undefined
      for (const res of childResults) {
        if (res.kind === 'ok' || res.kind === 'route') { outputs.push(res.output); continue }
        if (res.kind === 'skip' || res.kind === 'drop') continue
        if (res.kind === 'fail') {
          if (policy === 'skip') continue
          if (policy === 'collect') { outputs.push({ error: res.error }); continue }
          control = res
          break
        }
        // pause / stop: surface immediately so the run pauses/ends on this item.
        control = res
        break
      }
      if (control) {
        emit({ nodeId: node.id, status: control.kind === 'fail' ? 'failed' : control.kind === 'pause' ? 'waiting' : 'stopped', input: { items }, ...(control.kind === 'fail' ? { error: control.error, output: outputs } : {}) })
        return control
      }
      ctx.step[node.id] = { output: outputs }
      const failedItems = childResults.filter((res) => res.kind === 'fail').length
      const aggregateWarning = itemPolicyWarning(policy, failedItems, items.length)
      emit({ nodeId: node.id, status: 'succeeded', input: { items }, output: outputs, ...(aggregateWarning ? { warnings: [aggregateWarning] } : {}) })
      return { kind: 'ok', output: outputs }
    }

    if (node.type === 'stop') {
      emit({ nodeId: node.id, status: 'stopped', output: node.data.reason ?? 'Flow stopped.' })
      return { kind: 'stop' }
    }

    if (node.type === 'condition') {
      // Decide the branch here so the scheduler can resolve edges uniformly;
      // inside a container body (no branch edges) a 'branch' result threads no
      // output and the body just proceeds.
      const branch = evalCondition(node.data, ctx) ? 'true' : 'false'
      emit({ nodeId: node.id, status: 'succeeded', input: resolvedClauseInput(node.data), output: branch === 'true' })
      return { kind: 'branch', branch, output: branch === 'true' }
    }

    if (node.type === 'switch') {
      // First matching case wins, then the 'default' edge — unless the step
      // asks for every match, in which case each matching case's edge fires.
      const matches = node.data.cases.filter((c) =>
        evalClause({ left: c.left, op: c.op, right: c.right, ...(c.ignoreCase === undefined ? {} : { ignoreCase: c.ignoreCase }) }, ctx),
      )
      const branch: string | string[] = node.data.allMatches
        ? (matches.length ? matches.map((c) => c.id) : 'default')
        : (matches[0]?.id ?? 'default')
      const shown = Array.isArray(branch) ? branch.join(', ') : branch
      emit({
        nodeId: node.id,
        status: 'succeeded',
        input: { cases: node.data.cases.map((c) => ({ id: c.id, left: resolveTemplate(c.left, ctx), op: c.op, right: resolveTemplate(c.right, ctx) })) },
        output: shown,
      })
      return { kind: 'branch', branch, output: shown }
    }

    if (node.type === 'humanReview') {
      // Request information: a first-class pause with no agent involved.
      // Resuming this exact node (iteration)? The reviewer's reply IS the output.
      if (opts.resumeNodeId === stepKey) {
        const output = opts.resumeReply ?? ''
        ctx.step[node.id] = { output }
        emit({ nodeId: node.id, status: 'succeeded', output })
        return { kind: 'ok', output }
      }
      // First visit: resolve the message and pause the run. The outcome carries
      // the same `{ waiting: { kind: 'input', question } }` shape the agent
      // adapter persists, so execute-flow's onStep path can store it verbatim
      // and the existing reply machinery renders/answers it unchanged.
      const question = resolveTemplate(node.data.message, ctx)
      emit({ nodeId: node.id, status: 'waiting', input: { question }, output: { waiting: { kind: 'input', question } } })
      return { kind: 'pause', nodeId: stepKey, question }
    }

    if (node.type === 'wait') {
      // A first-class pause with no adapter (like humanReview). Resuming this
      // exact node? The reply — a webhook callback body, or empty for a timer —
      // becomes the step's output and the walk proceeds.
      if (opts.resumeNodeId === stepKey) {
        const reply = opts.resumeReply
        const output = reply !== undefined && reply !== '' ? asStructured(reply) : { resumed: true }
        ctx.step[node.id] = { output }
        emit({ nodeId: node.id, status: 'succeeded', output })
        return { kind: 'ok', output }
      }
      // First visit: compute the resume condition and pause the run.
      const nowMs = opts.now ? opts.now.unix * 1000 : Date.parse(new Date().toISOString())
      const waitInput = {
        mode: node.data.mode,
        ...(node.data.amount !== undefined ? { amount: resolveTemplate(node.data.amount, ctx) } : {}),
        ...(node.data.unit !== undefined ? { unit: node.data.unit } : {}),
        ...(node.data.until !== undefined ? { until: resolveTemplate(node.data.until, ctx) } : {}),
        ...(node.data.timeoutMinutes !== undefined ? { timeoutMinutes: node.data.timeoutMinutes } : {}),
      }
      if (node.data.mode === 'webhook') {
        const timeoutAt = node.data.timeoutMinutes ? new Date(nowMs + node.data.timeoutMinutes * 60_000).toISOString() : undefined
        emit({ nodeId: node.id, status: 'waiting', input: waitInput, output: { waiting: { kind: 'webhook', ...(timeoutAt ? { timeoutAt } : {}) } } })
        // A webhook wait with a safety timeout still records a resumeAt so the
        // cron scan can give up on a callback that never arrives.
        return { kind: 'pause', nodeId: stepKey, waitKind: 'webhook', ...(timeoutAt ? { resumeAt: timeoutAt } : {}) }
      }
      const timing = computeResumeAt(nowMs, {
        mode: node.data.mode,
        amount: node.data.amount !== undefined ? resolveTemplate(node.data.amount, ctx, onMissingToken) : undefined,
        unit: node.data.unit,
        until: node.data.until !== undefined ? resolveTemplate(node.data.until, ctx, onMissingToken) : undefined,
      })
      const broken = missingTokenFailure({ amount: node.data.amount, until: node.data.until })
      if (broken) return broken
      if ('error' in timing) {
        emit({ nodeId: node.id, status: 'failed', input: waitInput, error: timing.error })
        return { kind: 'fail', error: timing.error }
      }
      const resumeAt = new Date(timing.resumeAtMs).toISOString()
      emit({ nodeId: node.id, status: 'waiting', input: waitInput, output: { waiting: { kind: 'timer', resumeAt } } })
      return { kind: 'pause', nodeId: stepKey, waitKind: 'timer', resumeAt }
    }

    if (node.type === 'output') {
      // Named flow outputs: resolve each output's templated value and record a
      // named map into the run-level collector (later names override earlier).
      // A passthrough — the output IS the resolved map and the walk continues.
      const map: Record<string, unknown> = {}
      for (const entry of node.data.outputs) {
        const name = entry.name.trim()
        if (!name) continue // validate.ts blocks empty names; skip defensively at runtime
        map[name] = resolveTemplateValue(entry.value ?? '', ctx)
      }
      // An output node with no named entries is a no-op passthrough: it must
      // neither register an empty named-output map (which would surface as the
      // flow's named outputs and clobber the real last-step output) nor
      // overwrite the chained value with {}. validate.ts blocks an empty
      // outputs array as an error; this guards the degenerate case at runtime.
      const named = Object.keys(map).length > 0
      if (named) namedOutputs = { ...(namedOutputs ?? {}), ...map }
      ctx.step[node.id] = { output: map }
      emit({ nodeId: node.id, status: 'succeeded', input: lastOutput, output: map })
      return { kind: 'ok', output: named ? map : undefined }
    }

    if (node.type === 'join') {
      // Branch merge point. `passthrough` (default) forwards whichever single
      // branch reached it (condition/switch/error follow exactly one edge) — the
      // classic Join Paths, byte-identical to before. `append`/`combineByKey`
      // gather EVERY active incoming branch's output (an active edge means its
      // source ran, so ctx.step holds it) and combine them: append flattens into
      // one list, combineByKey full-outer-joins the record lists on `key`.
      const mode = node.data.mode ?? 'passthrough'
      if (mode === 'passthrough') {
        ctx.step[node.id] = { output: lastOutput }
        emit({ nodeId: node.id, status: 'succeeded', input: lastOutput, output: lastOutput })
        return { kind: 'ok', output: lastOutput }
      }
      const branchOutputs = (incomingSources.get(node.id) ?? [])
        .map((sourceId) => ctx.step[sourceId]?.output)
        .filter((value) => value !== undefined)
      // The two combine modes disagree on the sensible default, so each keeps
      // its own: combineByKey has always kept unmatched records (opt OUT), while
      // combine-by-position drops the overhang unless asked (opt IN), matching
      // n8n and the fact that a positional overhang is usually a mistake.
      const output =
        mode === 'append'
          ? mergeAppend(branchOutputs)
          : mode === 'combineByPosition'
            ? mergeByPosition(branchOutputs, node.data.includeUnpaired === true)
            : mode === 'allCombinations'
              ? mergeAllCombinations(branchOutputs)
              : mergeByKey(branchOutputs, node.data.key, node.data.includeUnpaired !== false)
      ctx.step[node.id] = { output }
      emit({ nodeId: node.id, status: 'succeeded', input: { branches: branchOutputs }, output })
      return { kind: 'ok', output }
    }

    if (node.type === 'transform') {
      // Build an object from templated field assignments (deterministic "Set").
      // A value that parses as JSON (number/bool/object/array) is typed; anything
      // else stays a string.
      // "Include Other Input Fields": start from the incoming record so the
      // mapped fields ADD to it rather than replace it. Only a record can be
      // spread; anything else is ignored so the step still yields an object.
      const carried = node.data.includeOtherFields === true && lastOutput && typeof lastOutput === 'object' && !Array.isArray(lastOutput)
        ? { ...(lastOutput as Record<string, unknown>) }
        : {}
      const output: Record<string, unknown> = carried
      for (const field of node.data.fields) {
        if (!field.name) continue
        const resolved = resolveTemplate(field.value, ctx)
        let value: unknown = resolved
        try {
          value = JSON.parse(resolved)
        } catch {
          /* not JSON — keep the string */
        }
        // A declared type is a request, not a guess: coerce to it when the
        // value can be, and leave the value untouched when it cannot, so a
        // mistyped field is visible in the output rather than silently null.
        output[field.name] = field.type ? coerceFieldType(value, field.type) : value
      }
      ctx.step[node.id] = { output }
      emit({ nodeId: node.id, status: 'succeeded', input: lastOutput, output })
      return { kind: 'ok', output }
    }

    if (node.type === 'variable') {
      const variableInput = {
        op: node.data.op,
        name: node.data.name,
        ...(node.data.value !== undefined ? { value: resolveTemplate(node.data.value, ctx) } : {}),
      }
      const res = applyVariableOp(node, ctx, declaredTypes)
      if ('error' in res) {
        emit({ nodeId: node.id, status: 'failed', input: variableInput, error: res.error })
        return { kind: 'fail', error: res.error }
      }
      ctx.step[node.id] = { output: res.output }
      emit({ nodeId: node.id, status: 'succeeded', input: variableInput, output: res.output })
      return { kind: 'ok', output: res.output }
    }

    if (node.type === 'data') {
      // Pure transform: resolve the input template here (an exact token keeps
      // its structure), then delegate to the side-effect-free op runner.
      // filterArray clauses / select values resolve per item inside runDataOp,
      // with this ctx riding along so step/trigger/var tokens keep working.
      const input = node.data.input?.trim() ? resolveTemplateValue(node.data.input, ctx) : undefined
      // A compose with no declared fields is a passthrough, so another tool's
      // expression left in `input` would flow downstream as literal text and
      // land in whatever consumes it — typically an auth header. Stop it here,
      // where the step that owns the bad reference is the one that fails.
      const unresolved = unresolvedReferenceFailure({ input })
      if (unresolved) return unresolved
      const res = runDataOp(node.data.op, {
        input,
        separator: node.data.separator === undefined ? undefined : resolveTemplate(node.data.separator, ctx),
        schema: node.data.schema,
        clauses: node.data.clauses,
        fields: node.data.fields,
        ctx,
        // Find/replace text and positions may reference flow data too.
        find: node.data.find === undefined ? undefined : resolveTemplate(node.data.find, ctx),
        replaceWith: node.data.replaceWith === undefined ? undefined : resolveTemplate(node.data.replaceWith, ctx),
        index: node.data.index === undefined ? undefined : resolveTemplate(node.data.index, ctx),
        count: node.data.count === undefined ? undefined : resolveTemplate(node.data.count, ctx),
        fromEnd: node.data.fromEnd,
        by: node.data.by,
        descending: node.data.descending,
        aggregations: node.data.aggregations,
        match: node.data.match,
        // Date fields: the pattern/amount/end-date may reference flow data.
        format: node.data.format === undefined ? undefined : resolveTemplate(node.data.format, ctx),
        unit: node.data.unit,
        amount: node.data.amount === undefined ? undefined : resolveTemplate(node.data.amount, ctx),
        part: node.data.part,
        to: node.data.to === undefined ? undefined : resolveTemplate(node.data.to, ctx),
      })
      if ('error' in res) {
        emit({ nodeId: node.id, status: 'failed', input: { op: node.data.op, input }, error: res.error })
        return { kind: 'fail', error: res.error }
      }
      ctx.step[node.id] = { output: res.output }
      emit({ nodeId: node.id, status: 'succeeded', input: { op: node.data.op, input }, output: res.output })
      return { kind: 'ok', output: res.output }
    }

    if (node.type === 'filter') {
      // Gate: pass through when the condition holds; else drop (loop) / end (chain).
      const passed = evalCondition(node.data, ctx)
      if (passed) {
        emit({ nodeId: node.id, status: 'succeeded', input: resolvedClauseInput(node.data), output: true })
        return { kind: 'ok', output: undefined }
      }
      emit({ nodeId: node.id, status: 'skipped', input: resolvedClauseInput(node.data), output: false })
      return { kind: 'drop' }
    }

    if (node.type === 'code') {
      const input = node.data.input?.trim()
        ? resolveTemplateValue(node.data.input, ctx, onMissingToken)
        : lastOutput
      const config: Record<string, unknown> = {
        language: node.data.language,
        mode: node.data.mode,
        code: node.data.code,
        input,
        timeoutMs: node.data.timeoutMs,
        context: {
          trigger: ctx.trigger,
          steps: ctx.step,
          variables: ctx.variables,
          now: ctx.now,
          run: ctx.run,
        },
      }
      const broken = missingTokenFailure(config)
      if (broken) return broken
      const res: RunAgentResult = opts.runAction
        ? await opts.runAction({ id: stepKey, kind: 'code', config })
        : { error: 'Code steps are not supported in this runtime.' }
      if (res.error) {
        const mode = node.data.onError ?? 'stop'
        emit({ nodeId: node.id, status: 'failed', error: res.error, ...(mode === 'route' || mode === 'continue' ? { output: { error: res.error, input } } : {}) })
        return onFailure(mode, res.error, input)
      }
      const output = asStructured(res.output)
      ctx.step[node.id] = { output }
      emit({ nodeId: node.id, status: 'succeeded', output })
      return { kind: 'ok', output }
    }

    if (node.type === 'tool' || node.type === 'http') {
      // Resolve every template in the node config, then delegate to runAction.
      let resolvedArgs: unknown
      if (node.type === 'tool') {
        try {
          resolvedArgs = resolveTemplateValue(JSON.parse(node.data.args ?? '{}'), ctx, onMissingToken)
        } catch {
          resolvedArgs = resolveTemplate(node.data.args ?? '{}', ctx, onMissingToken)
        }
      }
      const config: Record<string, unknown> =
        node.type === 'tool'
          ? {
              connectionId: node.data.connectionId,
              toolName: node.data.toolName,
              args: resolvedArgs,
              retries: node.data.retries,
              timeoutMs: node.data.timeoutMs,
            }
          : {
              ...(node.data.credentialId ? { credentialId: node.data.credentialId } : {}),
              ...(node.data.connectionId ? { connectionId: node.data.connectionId } : {}),
              method: node.data.method,
              url: resolveTemplate(node.data.url, ctx, onMissingToken),
              ...(node.data.sendQuery !== undefined ? { sendQuery: node.data.sendQuery } : {}),
              query: resolveConfigValue(node.data.query, ctx, onMissingToken),
              ...(node.data.sendHeaders !== undefined ? { sendHeaders: node.data.sendHeaders } : {}),
              headers: resolveConfigValue(node.data.headers, ctx, onMissingToken),
              ...(node.data.sendBody !== undefined ? { sendBody: node.data.sendBody } : {}),
              body: resolveConfigValue(node.data.body, ctx, onMissingToken),
              bodyMode: node.data.bodyMode,
              ...(node.data.contentType !== undefined ? { contentType: node.data.contentType } : {}),
              responseType: node.data.responseType,
              failOnHttpError: node.data.failOnHttpError,
              retries: node.data.retries,
              timeoutMs: node.data.timeoutMs,
              // Statics passed through unresolved — the adapter runs the
              // pagination loop and AI-optimize post-process.
              ...(node.data.pagination ? { pagination: node.data.pagination } : {}),
              ...(node.data.optimizeForAi ? { optimizeForAi: node.data.optimizeForAi } : {}),
            }
      const broken = missingTokenFailure(config) ?? unresolvedReferenceFailure(config)
      if (broken) return broken
      const res: RunAgentResult = opts.runAction
        ? await opts.runAction({ id: stepKey, kind: node.type, config, resume: opts.resumeNodeId === stepKey })
        : { error: `${node.type} steps are not supported in this runtime.` }
      if (res.waiting) {
        // A write tool queued for approval pauses the run, same as an agent step.
        emit({ nodeId: node.id, status: 'waiting' })
        return { kind: 'pause', nodeId: stepKey, question: res.waiting.question }
      }
      if (res.error) {
        const mode = node.data.onError ?? 'stop'
        emit({ nodeId: node.id, status: 'failed', error: res.error, ...(mode === 'route' || mode === 'continue' ? { output: { error: res.error, input: config } } : {}) })
        return onFailure(mode, res.error, config)
      }
      const output = asStructured(res.output)
      ctx.step[node.id] = { output }
      // Empty-result visibility: for http the payload is the envelope's body;
      // for tools the output itself. A succeeded-but-empty read is the classic
      // masked-upstream-stub bug — surface it instead of letting downstream
      // fail-soft paths hide it.
      const emptyTarget = node.type === 'http' && output && typeof output === 'object' && !Array.isArray(output) ? (output as Record<string, unknown>).body : output
      const emptyWarning = emptyResultWarning(emptyTarget)
      emit({ nodeId: node.id, status: 'succeeded', output, ...(emptyWarning ? { warnings: [emptyWarning] } : {}) })
      return { kind: 'ok', output }
    }

    if (node.type === 'ai') {
      // Only `input`/`instructions` carry {{tokens}}; every other field (aiOp,
      // model, categories, outputFields, score bounds, label, note, onError,
      // retries, timeoutMs) is a static the adapter (Task 3) reads as-is off
      // the spread. `retries`/`timeoutMs` ride through in `config` exactly like
      // tool/http's — the SAME reliability envelope: the interpreter dispatches
      // to the adapter ONCE and never retries or races a timeout itself here;
      // that enforcement belongs to the adapter, same as tool/http today.
      const resolvedInput = typeof node.data.input === 'string' && node.data.input.trim() ? resolveTemplate(node.data.input, ctx, onMissingToken) : node.data.input
      const resolvedInstructions =
        typeof node.data.instructions === 'string' && node.data.instructions.trim() ? resolveTemplate(node.data.instructions, ctx, onMissingToken) : node.data.instructions
      const config: Record<string, unknown> = { ...node.data, input: resolvedInput, instructions: resolvedInstructions }
      const broken = missingTokenFailure(config)
      if (broken) return broken
      const res: RunAgentResult = opts.runAction
        ? await opts.runAction({ id: stepKey, kind: 'ai', config, resume: opts.resumeNodeId === stepKey })
        : { error: 'ai steps are not supported in this runtime.' }
      if (res.waiting) {
        emit({ nodeId: node.id, status: 'waiting' })
        return { kind: 'pause', nodeId: stepKey, question: res.waiting.question }
      }
      if (res.error) {
        const mode = node.data.onError ?? 'stop'
        emit({ nodeId: node.id, status: 'failed', error: res.error, ...(mode === 'route' || mode === 'continue' ? { output: { error: res.error, input: config } } : {}) })
        return onFailure(mode, res.error, config)
      }
      const output = asStructured(res.output)
      ctx.step[node.id] = { output }
      emit({ nodeId: node.id, status: 'succeeded', output })
      return { kind: 'ok', output }
    }

    if (node.type === 'subflow') {
      // `input` and every `inputs` value carry {{tokens}}; flowId and the
      // reliability statics ride through untouched. Like ai/tool/http, the
      // interpreter dispatches ONCE — depth guards, retries, and timeouts are
      // the adapter's job.
      const resolvedInputs = node.data.inputs
        ? Object.fromEntries(Object.entries(node.data.inputs).map(([key, value]) => [key, resolveTemplate(value, ctx, onMissingToken)]))
        : undefined
      const resolvedInput = typeof node.data.input === 'string' && node.data.input.trim() ? resolveTemplate(node.data.input, ctx, onMissingToken) : node.data.input
      const config: Record<string, unknown> = { ...node.data, inputs: resolvedInputs, input: resolvedInput }
      const broken = missingTokenFailure(config)
      if (broken) return broken
      const res: RunAgentResult = opts.runAction
        ? await opts.runAction({ id: stepKey, kind: 'subflow', config, resume: opts.resumeNodeId === stepKey })
        : { error: 'subflow steps are not supported in this runtime.' }
      if (res.waiting) {
        emit({ nodeId: node.id, status: 'waiting' })
        return { kind: 'pause', nodeId: stepKey, question: res.waiting.question }
      }
      if (res.error) {
        const mode = node.data.onError ?? 'stop'
        emit({ nodeId: node.id, status: 'failed', error: res.error, ...(mode === 'route' || mode === 'continue' ? { output: { error: res.error, input: config } } : {}) })
        return onFailure(mode, res.error, config)
      }
      const output = asStructured(res.output)
      ctx.step[node.id] = { output }
      emit({ nodeId: node.id, status: 'succeeded', output })
      return { kind: 'ok', output }
    }

    if (node.type === 'knowledge') {
      // Read-only retrieval: resolve the query, dispatch once, thread the hit
      // list. No onError/retries — the adapter never throws (empty list on
      // any failure), matching retrieveKnowledge's best-effort contract.
      const query = resolveTemplate(node.data.query ?? '', ctx, onMissingToken)
      const config: Record<string, unknown> = { ...node.data, query }
      const broken = missingTokenFailure(config)
      if (broken) return broken
      const res: RunAgentResult = opts.runAction
        ? await opts.runAction({ id: stepKey, kind: 'knowledge', config, resume: opts.resumeNodeId === stepKey })
        : { error: 'knowledge steps are not supported in this runtime.' }
      if (res.error) {
        emit({ nodeId: node.id, status: 'failed', error: res.error })
        return { kind: 'fail', error: res.error }
      }
      const output = asStructured(res.output)
      ctx.step[node.id] = { output }
      // Knowledge retrieval is best-effort (empty on any failure), which makes
      // a zero-hit result doubly worth flagging — it may be a real "nothing
      // matched" or a swallowed backend failure.
      const emptyWarning = emptyResultWarning(output)
      emit({ nodeId: node.id, status: 'succeeded', output, ...(emptyWarning ? { warnings: [emptyWarning] } : {}) })
      return { kind: 'ok', output }
    }

    if (node.type === 'agent') {
      const outputFields = node.data.outputFields ?? []
      const structured = node.data.responseFormat === 'structured' && outputFields.some((field) => field.name.trim())
      let resolved = resolveTemplate(node.data.input ?? '{{trigger.input}}', ctx, onMissingToken)
      // Aggregated upstream context: when enabled, feed the agent EVERYTHING
      // earlier steps captured (each API/query node's data, labeled), so nodes
      // work together instead of the agent only seeing the tokens its input
      // named. Opt-in per node (`includeUpstreamContext: true`) — new agent
      // nodes default it on (see mutate.ts defaultData); existing flows are
      // untouched, so this never changes a run that didn't ask for it.
      if (node.data.includeUpstreamContext === true) {
        const contextBlock = buildUpstreamContextBlock(ctx, node.id)
        if (contextBlock) resolved = `${resolved}\n\n${contextBlock}`
      }
      if (structured) resolved = `${resolved}\n\n${structuredResponseInstruction(outputFields)}`
      const broken = missingTokenFailure(resolved)
      if (broken) return broken
      // Step-level agent configuration (model / memory / extra tools). The
      // memory session key is a template — resolving it here lets one step
      // keep separate threads per item ({{item.accountName}}).
      const memory = node.data.memory
      const overrides: AgentStepOverrides | undefined =
        node.data.model || memory || node.data.toolConnectionIds?.length
          ? {
              ...(node.data.model ? { model: node.data.model } : {}),
              ...(memory
                ? {
                    memory: {
                      store: memory.store ?? 'postgres',
                      sessionKey: memory.sessionKey?.trim()
                        ? resolveTemplate(memory.sessionKey, ctx)
                        : `flow-step:${node.id}`,
                      ...(memory.window ? { window: memory.window } : {}),
                    },
                  }
                : {}),
              ...(node.data.toolConnectionIds?.length ? { toolConnectionIds: node.data.toolConnectionIds } : {}),
            }
          : undefined
      const res = await runAgentWithReliability(node, resolved, stepKey, overrides)
      if (res.waiting) {
        if (node.data.humanAssistance === false) {
          const error = 'The agent asked for help, but human assistance is turned off for this step.'
          const mode = node.data.onError ?? 'stop'
          emit({ nodeId: node.id, status: 'failed', error, ...(mode === 'route' || mode === 'continue' ? { output: { error, input: resolved } } : {}) })
          return onFailure(mode, error, resolved)
        }
        emit({ nodeId: node.id, status: 'waiting' })
        return { kind: 'pause', nodeId: stepKey, question: res.waiting.question }
      }
      if (res.error) {
        const mode = node.data.onError ?? 'stop'
        emit({ nodeId: node.id, status: 'failed', error: res.error, ...(mode === 'route' || mode === 'continue' ? { output: { error: res.error, input: resolved } } : {}) })
        return onFailure(mode, res.error, resolved)
      }
      let output: unknown
      if (structured) {
        const parsed = parseStructuredAgentOutput(res.output, outputFields)
        if (parsed.error) {
          const mode = node.data.onError ?? 'stop'
          emit({ nodeId: node.id, status: 'failed', error: parsed.error, ...(mode === 'route' || mode === 'continue' ? { output: { error: parsed.error, input: resolved } } : {}) })
          return onFailure(mode, parsed.error, resolved)
        }
        output = parsed.output
      } else {
        output = asStructured(res.output)
      }
      ctx.step[node.id] = { output }
      emit({ nodeId: node.id, status: 'succeeded', output })
      return { kind: 'ok', output }
    }

    if (node.type === 'loop') {
      const rawItems = loopItems(resolveTemplate(node.data.over, ctx)).slice(0, maxLoop)
      // Batch size groups the list so each iteration receives an ARRAY of up to
      // N items as `{{item}}` — "post 50 records per call" instead of one call
      // per record. A size of 1 (the default) keeps the classic behaviour, item
      // by item, so existing loops are untouched.
      const batchSize = Math.max(1, node.data.batchSize ?? 1)
      const items: unknown[] = batchSize > 1 ? chunkItems(rawItems, batchSize) : rawItems
      const iterations = await mapLimit(items, node.data.concurrency ?? 1, async (item, index) => {
        // `variables` is shared by reference: writes inside the body persist
        // past the loop (one flow-global symbol table, MS parity).
        const itemCtx: FlowContext = { trigger: ctx.trigger, step: { ...ctx.step }, item, incoming: item, loop: { index, count: items.length }, variables: ctx.variables, now: ctx.now, run: ctx.run, stepAliases: ctx.stepAliases, stepLabels: ctx.stepLabels }
        // Each iteration's body persists/resumes under `#<index>` (nested loops
        // append their own suffix) so a mid-loop pause never re-runs a prior
        // iteration's side effects on resume.
        return execBody(node.data.body, itemCtx, `${indexKey}#${index}`)
      })
      // Per-iteration error tolerance: pause/stop always propagate; a 'drop'
      // (filter) removes that item; a 'fail' is subject to `itemError` — 'fail'
      // (default) propagates and fails the loop, 'skip'/'collect' don't.
      const policy = node.data.itemError ?? 'fail'
      let control: NodeResult | undefined
      for (const r of iterations) {
        const c = r.control
        if (!c || c.kind === 'drop') continue
        if (c.kind === 'fail') {
          if (policy === 'fail') { control = c; break }
          continue // skip / collect: don't propagate this iteration's failure
        }
        control = c
        break
      }
      if (control) {
        // A FAILED loop keeps its partial per-item results (errors marked
        // per item) — they were real work, and each #i row alone doesn't show
        // the aggregate shape downstream would have consumed. Pause/stop rows
        // stay output-less: the resume machinery re-enters them.
        const partial = iterations
          .filter((r) => r.control?.kind !== 'drop')
          .map((r) => (r.control?.kind === 'fail' ? { error: r.control.error } : r.output))
        emit({
          nodeId: node.id,
          status: control.kind === 'fail' ? 'failed' : control.kind === 'pause' ? 'waiting' : 'stopped',
          input: { items },
          ...(control.kind === 'fail' ? { error: control.error, output: partial } : {}),
        })
        return control
      }
      const output = iterations
        .filter((r) => r.control?.kind !== 'drop')
        .filter((r) => !(policy === 'skip' && r.control?.kind === 'fail'))
        .map((r) => (policy === 'collect' && r.control?.kind === 'fail' ? { error: r.control.error } : r.output))
      ctx.step[node.id] = { output }
      const failedIterations = iterations.filter((r) => r.control?.kind === 'fail').length
      const loopWarning = itemPolicyWarning(policy, failedIterations, items.length)
      emit({ nodeId: node.id, status: 'succeeded', input: { items }, output, ...(loopWarning ? { warnings: [loopWarning] } : {}) })
      return { kind: 'ok', output }
    }

    if (node.type === 'parallel') {
      const results = await Promise.all(
        node.data.branches.map(async (branch) => {
          const branchCtx: FlowContext = { trigger: ctx.trigger, step: { ...ctx.step }, item: ctx.item, incoming: ctx.incoming, loop: ctx.loop, variables: ctx.variables, now: ctx.now, run: ctx.run, stepAliases: ctx.stepAliases, stepLabels: ctx.stepLabels }
          // Branch node ids are already unique, so parallel just propagates the
          // ambient `indexKey` (a parallel nested in a loop keeps the loop's
          // iteration suffix; a top-level parallel keeps bare ids).
          const res = await execBody(branch, branchCtx, indexKey)
          return { key: branch[0] ?? node.id, res }
        }),
      )
      const control = results.map((r) => r.res.control).find((c): c is NodeResult => c !== undefined && c.kind !== 'drop')
      const parallelInput = { branches: node.data.branches }
      if (control) {
        // Keep the finished branches' outputs on a failed parallel — same
        // partial-work rationale as the loop above.
        const partial = Object.fromEntries(results.filter((r) => !r.res.control).map((r) => [r.key, r.res.output]))
        emit({
          nodeId: node.id,
          status: control.kind === 'fail' ? 'failed' : control.kind === 'pause' ? 'waiting' : 'stopped',
          input: parallelInput,
          ...(control.kind === 'fail' ? { error: control.error, output: partial } : {}),
        })
        return control
      }
      const output = Object.fromEntries(results.filter((r) => r.res.control?.kind !== 'drop').map((r) => [r.key, r.res.output]))
      ctx.step[node.id] = { output }
      emit({ nodeId: node.id, status: 'succeeded', input: parallelInput, output })
      return { kind: 'ok', output }
    }

    return { kind: 'skip' }
  }

  // Execute an ordered list of node ids (a loop body / parallel branch) as a
  // sequence, threading outputs. Stops on the first control signal.
  const execBody = async (nodeIds: string[], ctx: FlowContext, indexKey = ''): Promise<{ output: unknown; control?: NodeResult }> => {
    // Body chains thread the incoming value step to step: the loop's current
    // item (or the container's own incoming, for parallel branches) into the
    // first body node, then each data-producing step's output onward.
    let last: unknown = ctx.item !== undefined ? ctx.item : ctx.incoming
    for (const id of nodeIds) {
      const node = byId.get(id)
      if (!node) continue
      const res = await execNode(node, { ...ctx, incoming: last }, indexKey)
      // A container body is a flat list with no branch edges, so a route-on-error
      // failure can't follow an 'error' edge here — it behaves like 'continue',
      // threading the `{ error, input }` object to the next step in the body.
      if (res.kind === 'ok' || res.kind === 'route') {
        if (res.output !== undefined) {
          ctx.step[id] = { output: res.output }
          last = res.output
        }
        continue
      }
      if (res.kind === 'skip') continue
      return { output: last, control: res }
    }
    return { output: last }
  }

  // Node ids that live inside a container must not be reached by the main walk.
  const contained = new Set(
    graph.nodes.flatMap((node) =>
      node.type === 'loop' ? node.data.body : node.type === 'parallel' ? node.data.branches.flat() : [],
    ),
  )

  // Friendly-label aliases: normalized display label → node id, so hand-typed
  // `{{<label>.output}}` tokens resolve like the canonical `{{step.<id>...}}`
  // chips. First label wins on a duplicate — ambiguous names resolve to the
  // earliest step, matching how the builder lists them.
  const stepLabelMap = opts.stepLabels ?? stepLabelsOf(graph)
  const stepAliases: Record<string, string> = {}
  for (const [nodeId, label] of Object.entries(stepLabelMap)) {
    const alias = normalizeStepAlias(label)
    if (alias && stepAliases[alias] === undefined) stepAliases[alias] = nodeId
  }
  // Every graph node id also aliases itself, so a canonical token that names a
  // REAL step which produced no output on this walk (skipped branch, onError
  // 'continue', not-yet-merged parallel body) stays a valid-but-empty
  // reference instead of a hard "unknown reference" failure. Only tokens
  // naming nothing in the graph fail loudly.
  for (const node of graph.nodes) {
    if (node.type === 'trigger') continue
    const alias = normalizeStepAlias(node.id)
    if (alias && stepAliases[alias] === undefined) stepAliases[alias] = node.id
  }
  const ctx: FlowContext = { trigger: { input }, step: {}, variables: {}, now: opts.now, run: opts.run, stepAliases, stepLabels: stepLabelMap }

  // Resume: rebuild the symbol table from EVERY completed variable step before
  // walking. A completed loop/parallel short-circuits without entering its
  // body, so writes made inside container bodies would otherwise be lost.
  // `completed` preserves execution order (execute-flow builds it from step
  // rows ordered `order asc`), and each stored output IS the variable's
  // post-op value, so replay assigns outputs in that order — it never re-runs
  // the op — leaving the correct last write per name in place.
  if (opts.completed) {
    const variables = (ctx.variables ??= {})
    for (const [nodeId, output] of Object.entries(opts.completed)) {
      // Loop-body steps are keyed `${id}#${index}` — strip the suffix to find
      // the graph node (a variable written inside a completed loop must replay).
      const hash = nodeId.indexOf('#')
      const node = byId.get(hash === -1 ? nodeId : nodeId.slice(0, hash))
      if (node?.type === 'variable' && node.data.name.trim()) variables[node.data.name.trim()] = output
      // Named outputs are lost the same way: a completed output node hits the
      // short-circuit above and never re-enters the output branch, so its
      // declared names would fall back to the last-step output on final
      // completion (e.g. an output node BEFORE a humanReview pause). Rebuild the
      // run-level collector from each completed output step's stored map, in
      // completed-map order (execute-flow loads rows `order asc`, so later
      // output nodes override earlier — matching the live merge).
      if (node?.type === 'output' && output && typeof output === 'object' && !Array.isArray(output)) {
        const stored = output as Record<string, unknown>
        if (Object.keys(stored).length > 0) namedOutputs = { ...(namedOutputs ?? {}), ...stored }
      }
    }
  }

  // Attach the run-level named outputs (present only when ≥1 output node ran) to
  // every result. Undefined when no output node ran, preserving back-compat.
  const done = (result: InterpretResult): InterpretResult =>
    namedOutputs !== undefined ? { ...result, namedOutputs } : result

  // ── Dependency scheduler ──────────────────────────────────────────────────
  // Replaces the single-active-path walk. A node runs once its incoming edges
  // resolve (all terminal, ≥1 active); a node whose incoming edges are all dead
  // is skipped and its own out-edges go dead (dead-path elimination / OR-join).
  // Independent ready nodes run concurrently. Containers stay single nodes.
  const { incoming, outgoing: outEdges, dagNodeIds } = buildAdjacency(graph.nodes, graph.edges, contained)
  const edgeState = new Map<FlowEdge, EdgeState>(graph.edges.map((edge) => [edge, 'unresolved']))
  const nodeState = new Map<string, NodeRunState>(dagNodeIds.map((id) => [id, 'pending']))
  // The entry point (the trigger, or the first node) is the ONLY seed — a node
  // with no incoming edges that ISN'T the entry is an unreachable orphan and
  // must never run, exactly as the old walk (which only reached nodes via
  // edges) left it untouched.
  const entryId = byId.has('trigger') ? 'trigger' : dagNodeIds[0]

  const resolveEdges = (id: string, result: EdgeResult) => {
    const acts = edgeActivationsFor(result, outEdges.get(id) ?? [])
    for (const [edge, state] of acts) if (edgeState.get(edge) === 'unresolved') edgeState.set(edge, state)
  }
  const incomingResolved = (id: string) => (incoming.get(id) ?? []).every((edge) => edgeState.get(edge) !== 'unresolved')
  const hasActiveIncoming = (id: string) => (incoming.get(id) ?? []).some((edge) => edgeState.get(edge) === 'active')

  // Dead-path elimination, run to a fixpoint so deadness cascades. A node with
  // no incoming edges is never skipped here (the entry runs; orphans idle).
  const markSkipped = (id: string) => {
    nodeState.set(id, 'skipped')
    for (const edge of outEdges.get(id) ?? []) if (edgeState.get(edge) === 'unresolved') edgeState.set(edge, 'dead')
  }
  const propagateSkips = () => {
    let changed = true
    while (changed) {
      changed = false
      for (const id of dagNodeIds) {
        if (nodeState.get(id) !== 'pending') continue
        if ((incoming.get(id) ?? []).length === 0) continue
        if (!incomingResolved(id) || hasActiveIncoming(id)) continue
        markSkipped(id)
        changed = true
      }
    }
  }

  let terminal: InterpretResult | null = null
  let lastOutput: unknown = input // filter-drop / no-sink back-compat output

  // What `{{input}}` means per node: the value carried into it along its own
  // path. Tracked per node (unlike the global lastOutput) so parallel branches
  // each read their own upstream. A node that produces no chained data (a
  // branch decision, a passing filter) carries its own incoming value onward.
  const carriedInto = new Map<string, unknown>()

  const runOne = async (node: FlowNode): Promise<void> => {
    nodeState.set(node.id, 'running')
    const nodeIncoming = carriedInto.has(node.id) ? carriedInto.get(node.id) : input
    const res = await execNode(node, { ...ctx, incoming: nodeIncoming })
    if (terminal) return // a sibling already ended the run; ignore late results
    if (res.kind === 'fail') { terminal = done({ status: 'failed', steps, output: lastOutput, error: res.error }); return }
    if (res.kind === 'pause') { terminal = done({ status: 'waiting', steps, output: lastOutput, waiting: { nodeId: res.nodeId, question: res.question, ...(res.resumeAt ? { resumeAt: res.resumeAt } : {}), ...(res.waitKind ? { waitKind: res.waitKind } : {}) } }); return }
    if (res.kind === 'stop') { nodeState.set(node.id, 'done'); terminal = done({ status: 'succeeded', steps, output: lastOutput }); return }
    if (res.kind === 'drop') { nodeState.set(node.id, 'skipped'); resolveEdges(node.id, 'drop'); return }
    // Only surface a chained value when there is one: a route always carries its
    // { error, input } object; an `ok` with an undefined output (a passing
    // filter, an empty output node) must NOT clobber the last real value.
    if (res.kind === 'route' || (res.kind === 'ok' && res.output !== undefined)) lastOutput = res.output
    // Same produced-chained-data rule as lastOutput above, but per path: seed
    // every downstream target before its edges resolve. Dead-branch targets
    // never run, so a value seeded toward them is inert.
    const carriedOut = res.kind === 'route' || (res.kind === 'ok' && res.output !== undefined) ? res.output : nodeIncoming
    for (const edge of outEdges.get(node.id) ?? []) carriedInto.set(edge.target, carriedOut)
    nodeState.set(node.id, 'done')
    resolveEdges(node.id, res.kind === 'branch' ? { branch: res.branch } : res.kind === 'route' ? 'route' : res.kind === 'skip' ? 'skip' : 'ok')
    // Partial execution: stop the walk the moment the requested node finishes,
    // surfacing its output as the run result. In-flight siblings settle below.
    if (opts.stopAfterNodeId && node.id === opts.stopAfterNodeId) {
      terminal = done({ status: 'succeeded', steps, output: ctx.step[node.id]?.output ?? lastOutput })
    }
  }

  const running = new Set<Promise<void>>()
  const readyNodes = () =>
    dagNodeIds.filter((id) =>
      // "Execute previous nodes": never schedule the target itself, so the walk
      // reaches quiescence once everything feeding it has run.
      id !== opts.stopBeforeNodeId &&
      nodeState.get(id) === 'pending' && (id === entryId || (incomingResolved(id) && hasActiveIncoming(id))),
    )

  // A node the entry can't reach never runs (orphans idle) — but if it has
  // out-edges into the live graph (an import can leave a demoted trigger stub
  // wired to the first real step), those edges would sit 'unresolved' forever
  // and freeze every downstream join waiting on them. Resolve the whole
  // unreachable region to skipped/dead up front so reachable joins see a
  // terminal edge state, not a forever-pending one.
  {
    const reachableFromEntry = new Set<string>([entryId])
    const queue = [entryId]
    while (queue.length) {
      const current = queue.shift()!
      for (const edge of outEdges.get(current) ?? []) {
        if (!reachableFromEntry.has(edge.target)) {
          reachableFromEntry.add(edge.target)
          queue.push(edge.target)
        }
      }
    }
    for (const id of dagNodeIds) if (!reachableFromEntry.has(id)) markSkipped(id)
  }

  propagateSkips()
  while (!terminal) {
    // Cooperative cancellation: checked once per tick before scheduling more
    // work. In-flight nodes below settle in the caller's catch; no new node runs.
    if (opts.isCancelled && (await opts.isCancelled())) throw new FlowCancelledError()
    const ready = readyNodes()
    if (ready.length === 0) {
      if (running.size === 0) break // quiescent — the run is done
      await Promise.race(running)
      propagateSkips()
      continue
    }
    for (const id of ready) {
      if (running.size >= MAX_CONCURRENT_NODES) break
      const node = byId.get(id)!
      const promise = runOne(node).finally(() => running.delete(promise))
      running.add(promise)
    }
    await Promise.race(running)
    propagateSkips()
  }
  await Promise.allSettled(running) // let in-flight nodes settle before returning
  if (terminal) return terminal

  // Terminal output: named outputs win; else the sinks (done nodes with no
  // active out-edge). One data sink → its output (linear back-compat); several
  // → aggregate by label; none → the last value carried into a dead end.
  const sinkOutputs: { label: string; output: unknown }[] = []
  for (const id of dagNodeIds) {
    if (nodeState.get(id) !== 'done') continue
    // `output` nodes contribute to namedOutputs, not the implicit sink output.
    if (byId.get(id)?.type === 'output') continue
    if ((outEdges.get(id) ?? []).some((edge) => edgeState.get(edge) === 'active')) continue
    const entry = ctx.step[id]
    if (entry !== undefined) sinkOutputs.push({ label: stepLabelMap[id] || id, output: entry.output })
  }
  let output: unknown = lastOutput
  if (sinkOutputs.length === 1) output = sinkOutputs[0].output
  else if (sinkOutputs.length > 1) output = Object.fromEntries(sinkOutputs.map((s) => [s.label, s.output]))
  return done({ status: 'succeeded', steps, output })
}

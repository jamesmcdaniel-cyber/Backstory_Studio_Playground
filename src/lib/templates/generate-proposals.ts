import { UNTRUSTED_DATA_RULE } from '@/lib/security/prompt'
/**
 * The HEART of sub-project C: turn a workspace's usage profile + graph-RAG
 * context into REVIEWABLE `TemplateProposal`s. This NEVER auto-publishes — it
 * writes `status:'open'` suggestions only; a human accepts one later (Task 4)
 * before anything becomes a live template.
 *
 * The flow is: gate → assemble grounded context → ONE `generateStructured`
 * call (strict schema, free-form config/evidence via the string-wrapper
 * pattern) → dedupe against the catalogue + open proposals → cap → write.
 *
 * The core is dependency-INJECTED (see {@link GenerateDeps}) so it is unit
 * testable without a DB or a live model: tests pass a fake `generate` plus fake
 * reads. The pure helpers (`intentKey`, `dedupeProposals`, `normalizeProposal`)
 * are exported and tested directly.
 *
 * TENANT SAFETY: every read/write carries `organizationId`; RAG retrieval passes
 * the ORG viewer scope (viewerUserId null = shared-only, never a rep's private
 * nodes). COST BOUNDS: exactly one bounded (`PROPOSAL_MAX_TOKENS`) model call,
 * gated so it never runs below the integration threshold; dedupe + an ≤8 cap
 * stop proposal spam.
 */

import { prisma } from '@/lib/prisma'
import type { Prisma } from '@prisma/client'
import { DEFAULT_AGENT_MODEL, generateStructured } from '@/lib/llm/model-runner'
import {
  countConnectedIntegrations,
  meetsTemplateGate,
} from '@/lib/integrations/integration-count'
import { buildUsageProfile, type UsageProfile } from '@/lib/templates/usage-profile'
import { listStoredCatalogue } from '@/lib/templates/catalogue'
import { listAllProposalTitles, writeProposals, type ProposalInput } from '@/lib/templates/proposals'
import { NANGO_PROVIDERS } from '@/lib/nango/provider-tools'
import { retrieveContext, renderContext, type RetrievedContext } from '@/lib/rag/retrieve'
import { getGraphRagStore } from '@/lib/rag/get-store'
import { readAgentMetadata } from '@/lib/agents/metadata'
import { enhanceAutomationInstructions } from '@/lib/templates/automation-assets'

/** The three proposal kinds. Template kinds promote to an AgentTemplate on accept. */
export const PROPOSAL_KINDS = ['agent_template', 'flow_template', 'process_improvement'] as const
export type ProposalKind = (typeof PROPOSAL_KINDS)[number]
const TEMPLATE_KINDS: ReadonlySet<string> = new Set(['agent_template', 'flow_template'])

/**
 * Never surface more than this many proposals per run. Deliberately small: the
 * product wants a FEW high-signal suggestions, not a review queue. Combined with
 * the confidence floor below, most runs surface 0–3.
 */
export const MAX_PROPOSALS = 3
/**
 * Drop any proposal the model scores below this confidence (0–1). The model must
 * justify a proposal from observed usage; a low self-assessed confidence means
 * "speculative", which we don't show. Server-enforced, not just prompt-hinted.
 */
export const CONFIDENCE_FLOOR = 0.6
/**
 * Minimum observed RUNS (distinct executions with real tool usage in the window)
 * before we recommend anything. The integration gate proves they CONNECTED
 * enough; this proves we've actually LEARNED how they work. Without it, an org
 * that connects 3 integrations and runs nothing would get recommendations
 * grounded only on what those integrations *can* do — not what they do.
 */
export const MIN_RUNS_FOR_TEMPLATES = 3
/** Bounded output for the single structured call (cost cap). */
export const PROPOSAL_MAX_TOKENS = 8000
/**
 * The gate is an ORG-level count. `countConnectedIntegrations` →
 * `listConnectedProviders(orgId, userId)` IGNORES its userId arg (parity only —
 * see usage-profile.ts), so '' means "the whole org, no specific rep". Using ''
 * (rather than an owner id we'd have to look up) keeps the gate a pure org read.
 */
export const ORG_GATE_USER_ID = ''

const PROVIDER_SET: ReadonlySet<string> = new Set(NANGO_PROVIDERS)

// Words that carry no intent — stripped when computing the dedupe intent key so
// "Weekly deal-risk digest" and "The deal risk digest" collide.
const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'for', 'to', 'of', 'and', 'with', 'your', 'my', 'our', 'in', 'on', 'from',
])

// --------------------------------------------------------------------------
// Strict output schema — mirrors DRAFT_SCHEMA (agents/draft route): every field
// required, enums where the value space is bounded, and the two FREE-FORM parts
// (`configJson`, `sourceEvidenceJson`) carried as JSON STRINGS. Anthropic strict
// structured outputs cannot express a free-form object ({type:'object'} with no
// properties collapses to {} under additionalProperties:false), so per the flow
// copilot's string-wrapper pattern the model emits them as strings we JSON.parse
// ourselves (tolerant of ```json fences). See parseProposalsReply / tolerantObject.
// --------------------------------------------------------------------------
export const PROPOSAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    proposals: {
      type: 'array',
      description: `Between 0 and ${MAX_PROPOSALS} grounded proposals. Omit anything you cannot justify from the usage evidence.`,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: {
            type: 'string',
            enum: [...PROPOSAL_KINDS],
            description: 'agent_template / flow_template for a NEW template; process_improvement to improve an EXISTING flow or agent.',
          },
          title: { type: 'string', description: 'Short, specific name for the proposal.' },
          category: { type: 'string', description: 'Domain category, e.g. "Sales", "Reporting", "Ops". Empty string if unsure.' },
          instructions: {
            type: 'string',
            description: 'For a template kind: detailed second-person operating instructions covering objective, inputs, exact tool sequence, decision logic, edge cases, data-quality rules, outputs, delivery, and success criteria. Empty string for process_improvement.',
          },
          integrations: {
            type: 'array',
            items: { type: 'string', enum: [...NANGO_PROVIDERS] },
            description: 'Only integrations the proposal actually uses. Empty array if none.',
          },
          schedule: {
            type: 'string',
            enum: ['manual', 'hourly', 'daily', 'weekly', 'cron', ''],
            description: 'Cadence when the template should run; empty string if not applicable.',
          },
          exampleOutput: { type: 'string', description: 'A concrete, realistic example showing the structure and depth of the primary output, including key sections and representative fields. Empty string if not applicable.' },
          rationale: { type: 'string', description: 'Why this proposal fits THIS workspace, referencing the observed usage.' },
          confidence: {
            type: 'number',
            description: 'Your confidence (0.0–1.0) that this is a genuinely useful automation grounded in the observed usage, NOT speculative. Below 0.6 will be discarded — omit weak ideas rather than pad the list.',
          },
          targetType: {
            type: 'string',
            enum: ['flow', 'agent', ''],
            description: 'process_improvement ONLY: whether targetId is an existing flow or agent. Empty string for template kinds.',
          },
          targetId: {
            type: 'string',
            description: 'process_improvement ONLY: the exact id of an existing flow/agent from the provided list. Empty string for template kinds.',
          },
          configJson: {
            type: 'string',
            description: 'process_improvement ONLY: a JSON object string with the improvement, e.g. {"notes":"...","diff":"..."}. Empty string for template kinds.',
          },
          sourceEvidenceJson: {
            type: 'string',
            description: 'A JSON object string naming the usage signals that justify this proposal, e.g. {"providers":["slack","people.ai"],"reason":"..."}. Empty string if none.',
          },
        },
        required: [
          'kind', 'title', 'category', 'instructions', 'integrations', 'schedule',
          'exampleOutput', 'rationale', 'confidence', 'targetType', 'targetId', 'configJson', 'sourceEvidenceJson',
        ],
      },
    },
  },
  required: ['proposals'],
} as const

/** One raw proposal as the model returns it (before server-side validation). */
export interface RawProposal {
  kind: string
  title: string
  category: string
  instructions: string
  integrations: string[]
  schedule: string
  exampleOutput: string
  rationale: string
  confidence: number
  targetType: string
  targetId: string
  configJson: string
  sourceEvidenceJson: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/**
 * Tolerantly parse a free-form JSON-object string (the string-wrapper payload):
 * strips ```json fences, returns {} on empty/invalid/non-object — the free-form
 * blob must never break generation.
 */
export function tolerantObject(raw: string): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  const trimmed = raw.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const body = fenced ? fenced[1].trim() : trimmed
  try {
    const value = JSON.parse(body)
    return isRecord(value) ? value : {}
  } catch {
    return {}
  }
}

/**
 * Extract the proposal array from a structured reply shaped as
 * `{ proposals: [...] }` (tolerant of a bare array). Non-object items are
 * dropped. Throws only if the outer JSON is unparseable (caller treats as skip).
 */
export function parseProposalsReply(raw: string): RawProposal[] {
  const outer = JSON.parse(raw)
  const arr = isRecord(outer) && Array.isArray(outer.proposals)
    ? outer.proposals
    : Array.isArray(outer)
      ? outer
      : []
  return arr.filter(isRecord) as unknown as RawProposal[]
}

/** Case-insensitive, whitespace-collapsed title — the exact-match dedupe key. */
export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * A cheap order-independent INTENT key: lowercase, punctuation → spaces, drop
 * stopwords, dedupe + sort the remaining words. Catches near-duplicate titles
 * that differ only in word order or filler ("Weekly deal digest" vs
 * "Deal digest, weekly"). Empty string when the title is all stopwords/symbols.
 */
export function intentKey(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
  return [...new Set(words)].sort().join(' ')
}

/**
 * Drop proposals whose normalized title OR intent key matches an existing
 * catalogue/open-proposal title — AND dedupe within the batch itself (a later
 * proposal colliding with an earlier kept one is dropped). Pure; order-stable.
 */
export function dedupeProposals<T extends { title: string }>(proposals: T[], existingTitles: string[]): T[] {
  const seen = new Set<string>()
  for (const t of existingTitles) {
    const nk = normalizeTitle(t)
    if (nk) seen.add(nk)
    const ik = intentKey(t)
    if (ik) seen.add(ik)
  }
  const out: T[] = []
  for (const p of proposals) {
    const nk = normalizeTitle(p.title)
    if (!nk) continue
    const ik = intentKey(p.title)
    if (seen.has(nk) || (ik && seen.has(ik))) continue
    seen.add(nk)
    if (ik) seen.add(ik)
    out.push(p)
  }
  return out
}

/** Compact, PII-free usage signals attached to EVERY proposal's sourceEvidence. */
export function usageSignals(profile: UsageProfile): Record<string, unknown> {
  return {
    providers: profile.providers.map((p) => p.provider),
    coOccurrence: profile.coOccurrence.slice(0, 8),
    sequences: profile.sequences.slice(0, 8),
    runCount: profile.runCount,
    windowDays: profile.windowDays,
    themes: profile.themes,
  }
}

export interface NormalizeContext {
  profile: UsageProfile
  flowIds: ReadonlySet<string>
  agentIds: ReadonlySet<string>
}

/**
 * Validate + shape one raw proposal into a writable `ProposalInput`, or return
 * null to DROP it. Guarantees:
 *  - kind is one of the three; title is non-empty.
 *  - a process_improvement targets a REAL flow/agent id (targetType-matched) —
 *    else dropped, so accept can never open a non-existent editor.
 *  - integrations are filtered to known Nango providers.
 *  - configuration is the blob Task-4 accept consumes (template kinds → the
 *    AgentTemplate.configuration shape; process_improvement → target + notes).
 *  - sourceEvidence ALWAYS carries the server-computed usage signals (the model
 *    can't fabricate the evidence away), merged over whatever it supplied.
 */
export function normalizeProposal(raw: RawProposal, ctx: NormalizeContext): ProposalInput | null {
  const kind = typeof raw.kind === 'string' ? raw.kind.trim() : ''
  if (!TEMPLATE_KINDS.has(kind) && kind !== 'process_improvement') return null
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (!title) return null
  // Confidence floor: drop speculative proposals server-side (not just via the
  // prompt). A missing/NaN score is treated as below the floor.
  const confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? raw.confidence : 0
  if (confidence < CONFIDENCE_FLOOR) return null

  const modelEvidence = tolerantObject(raw.sourceEvidenceJson)
  // These blobs are genuine JSON (parsed from JSON / plain values), so the cast
  // to Prisma's InputJsonValue is sound; the Record<string,unknown> index
  // signature just isn't structurally assignable to the recursive JSON type.
  const sourceEvidence = { ...modelEvidence, kind, confidence, usage: usageSignals(ctx.profile) } as unknown as Prisma.InputJsonValue

  if (kind === 'process_improvement') {
    const targetType = raw.targetType === 'flow' || raw.targetType === 'agent' ? raw.targetType : null
    const targetId = typeof raw.targetId === 'string' ? raw.targetId.trim() : ''
    if (!targetType || !targetId) return null
    const known = targetType === 'flow' ? ctx.flowIds : ctx.agentIds
    if (!known.has(targetId)) return null // must target a real, current flow/agent
    // Server-validated targetType/targetId go LAST so a model-supplied
    // configJson can never override the ids we just checked against
    // ctx.flowIds/agentIds (mirrors the sourceEvidence merge below).
    const configuration = {
      ...tolerantObject(raw.configJson),
      targetType,
      targetId,
    } as unknown as Prisma.InputJsonValue
    return {
      userId: null,
      title,
      rationale: typeof raw.rationale === 'string' ? raw.rationale : '',
      kind,
      configuration,
      sourceEvidence,
    }
  }

  // Template kind: shape configuration to the AgentTemplate.configuration blob
  // (see serializeTemplate / createTemplate) so Task-4 accept can spread it.
  const integrations = Array.isArray(raw.integrations)
    ? [...new Set(raw.integrations.filter((i): i is string => typeof i === 'string' && PROVIDER_SET.has(i)))]
    : []
  const configuration: Record<string, unknown> = {
    name: title,
    category: typeof raw.category === 'string' ? raw.category : '',
    instructions: enhanceAutomationInstructions(typeof raw.instructions === 'string' ? raw.instructions : ''),
    integrations,
    exampleOutput: typeof raw.exampleOutput === 'string' ? raw.exampleOutput : '',
    model: DEFAULT_AGENT_MODEL,
  }
  if (typeof raw.schedule === 'string' && raw.schedule.trim()) {
    configuration.schedule = raw.schedule.trim()
  }
  return {
    userId: null,
    title,
    rationale: typeof raw.rationale === 'string' ? raw.rationale : '',
    kind,
    configuration: configuration as unknown as Prisma.InputJsonValue,
    sourceEvidence,
  }
}

/** A cheap flow/agent id+name pair the model targets process_improvement at. */
export interface ImprovementTarget {
  id: string
  name: string
}

// --------------------------------------------------------------------------
// Injectable dependencies. Defaults are the real DB/model calls; tests override
// `generate` and the reads to exercise the core without a DB or network.
// --------------------------------------------------------------------------
export interface GenerateDeps {
  countConnected?: (organizationId: string, userId: string) => Promise<number>
  buildProfile?: (organizationId: string) => Promise<UsageProfile>
  retrieve?: (organizationId: string, profile: UsageProfile) => Promise<RetrievedContext>
  readCatalogueTitles?: (organizationId: string) => Promise<string[]>
  /** Titles of ALL prior proposals (open + dismissed + accepted), for dedup. */
  readPriorTitles?: (organizationId: string) => Promise<string[]>
  readTargets?: (organizationId: string) => Promise<{ flows: ImprovementTarget[]; agents: ImprovementTarget[] }>
  generate?: (opts: {
    system: string
    user: string
    schema: Record<string, unknown>
    schemaName: string
    maxTokens?: number
  }) => Promise<string>
  write?: (organizationId: string, rows: ProposalInput[]) => Promise<number>
}

/** Default: correlated-context retrieval, org viewer scope (shared-only), best-effort. */
async function defaultRetrieve(organizationId: string, profile: UsageProfile): Promise<RetrievedContext> {
  const providers = profile.providers.slice(0, 5).map((p) => p.provider)
  const query = [
    'Recurring, high-value cross-integration workflows for this workspace.',
    providers.length ? `Active integrations: ${providers.join(', ')}.` : '',
    profile.themes.length ? `Signal themes: ${profile.themes.slice(0, 10).join(', ')}.` : '',
  ].filter(Boolean).join(' ')
  try {
    // viewerUserId null = ORG/shared scope only — never a rep's private nodes.
    return await retrieveContext(getGraphRagStore(), { organizationId, viewerUserId: null, query })
  } catch {
    return { hits: [], related: [] }
  }
}

/** Default: the org's flows + active agents, id+name, bounded — process_improvement targets. */
async function defaultReadTargets(organizationId: string): Promise<{ flows: ImprovementTarget[]; agents: ImprovementTarget[] }> {
  const [flows, agents] = await Promise.all([
    prisma.flow.findMany({ where: { organizationId }, select: { id: true, name: true }, orderBy: { updatedAt: 'desc' }, take: 50 }),
    prisma.agentTask.findMany({
      where: { organizationId, type: 'agent', status: 'ACTIVE' },
      select: { id: true, description: true, metadata: true },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    }),
  ])
  return {
    flows: flows.map((f) => ({ id: f.id, name: f.name })),
    agents: agents.map((a) => ({ id: a.id, name: readAgentMetadata(a.metadata).title || a.description })),
  }
}

/** Compact grounding lines for the model prompt. Pure over its inputs. */
export function buildGenerationUser(
  profile: UsageProfile,
  contextMd: string,
  existingTitles: string[],
  targets: { flows: ImprovementTarget[]; agents: ImprovementTarget[] },
): string {
  const lines: string[] = []
  lines.push('## Observed usage')
  lines.push(`Runs analyzed: ${profile.runCount} over the last ${profile.windowDays} days.`)
  if (profile.providers.length) lines.push(`Providers (by calls): ${profile.providers.map((p) => `${p.provider}(${p.calls})`).join(', ')}`)
  if (profile.topTools.length) lines.push(`Top tools: ${profile.topTools.slice(0, 12).map((t) => `${t.provider}.${t.tool}(${t.calls})`).join(', ')}`)
  if (profile.coOccurrence.length) lines.push(`Providers used together in a run: ${profile.coOccurrence.map((c) => `[${c.providers.join('+')}]×${c.runs}`).join(', ')}`)
  if (profile.sequences.length) lines.push(`Common provider sequences: ${profile.sequences.map((s) => `${s.steps.join('→')}×${s.count}`).join(', ')}`)
  if (profile.capabilities.length) lines.push(`Connected provider capabilities: ${profile.capabilities.map((c) => `${c.provider}: ${c.capabilities.slice(0, 8).join('/')}`).join(' | ')}`)
  if (profile.themes.length) lines.push(`Sales-AI signal themes present: ${profile.themes.join(', ')}`)
  if (contextMd.trim()) {
    lines.push('', contextMd.trim())
  }
  lines.push('', '## Existing templates (do NOT duplicate these titles/intents)')
  lines.push(existingTitles.length ? existingTitles.map((t) => `- ${t}`).join('\n') : '- (none yet)')
  lines.push('', '## Existing flows you may propose process_improvement for (use the exact id)')
  lines.push(targets.flows.length ? targets.flows.map((f) => `- ${f.name} (id: ${f.id})`).join('\n') : '- (none)')
  lines.push('', '## Existing agents you may propose process_improvement for (use the exact id)')
  lines.push(targets.agents.length ? targets.agents.map((a) => `- ${a.name} (id: ${a.id})`).join('\n') : '- (none)')
  return lines.join('\n')
}

const GENERATION_SYSTEM = [
  'You propose REVIEWABLE automation templates for a team workspace, grounded strictly in its observed integration usage.',
  UNTRUSTED_DATA_RULE,
  'Return AT MOST 3 proposals, and only ones you can justify from the evidence — returning 0 or 1 is the right answer when nothing strongly fits. Quality over quantity; never invent usage that is not in the evidence. Set `confidence` (0–1) honestly for each; anything below 0.6 is discarded, so omit weak ideas rather than pad the list.',
  'Two families: (1) NEW templates — kind agent_template (a single autonomous agent) or flow_template (a multi-step workflow) that automates a recurring, cross-integration pattern you see. Write implementation-grade second-person instructions with: objective and success criteria; required inputs and defaults; exact ordered tool/step plan; joins and field mappings; decision rules and thresholds; pagination/batching; retries, idempotency, deduplication, and partial-failure handling; approval gates for writes; data-quality and no-fabrication rules; output sections; delivery behavior; monitoring; and concrete test cases. Include only the integrations the task needs, a detailed example output, and a cadence when periodic. (2) process_improvement — an upgrade to an EXISTING flow or agent from the provided list; set targetType and the exact targetId, leave instructions empty, and put a specific implementation plan in configJson as a JSON object string with notes, diff, acceptanceCriteria, risks, and testPlan.',
  'For flow_template, describe a deterministic graph with stable step names, dependencies, branch conditions, inputs, outputs, and failure paths. For agent_template, define tool-selection boundaries and when to ask for clarification. Never use vague instructions such as “analyze the data” without naming the analysis and required output.',
  'The server appends a standard asset contract for polished HTML, canonical workflow JSON, cross-platform mappings, and an operations README. Focus your instructions on the automation’s domain-specific logic and make them detailed enough for that contract to produce a deployable package.',
  'Do NOT duplicate an existing template title or its intent. Prefer proposals that combine providers you see used together.',
  'For sourceEvidenceJson, return a JSON object string naming the specific signals (providers, co-occurrences, themes) that justify the proposal.',
].join('\n')

/**
 * Generate grounded, reviewable template proposals for an org.
 *
 * Returns `{ written, skipped }`:
 *  - `skipped:'gate'` (written 0) when the org is below the integration
 *    threshold — the model is NEVER called (cost + correctness).
 *  - `skipped:'parse'` (written 0) when the model reply can't be parsed.
 *  - otherwise `skipped:null` and `written` = rows created (0 is valid).
 * A hard `generateStructured` failure (provider outage) PROPAGATES rather than
 * skipping, so the BullMQ job retries the org instead of silently giving up;
 * it throws before any write, so there is never a half-written batch.
 *
 * @param deps injected for testing; defaults are the real DB/model calls.
 */
export async function generateTemplateProposals(
  organizationId: string,
  deps: GenerateDeps = {},
): Promise<{ written: number; skipped: string | null }> {
  const countConnected = deps.countConnected ?? countConnectedIntegrations
  const buildProfile = deps.buildProfile ?? buildUsageProfile
  const retrieve = deps.retrieve ?? defaultRetrieve
  const readCatalogueTitles = deps.readCatalogueTitles ?? (async (org) => (await listStoredCatalogue(org)).map((t) => t.name))
  const readPriorTitles = deps.readPriorTitles ?? listAllProposalTitles
  const readTargets = deps.readTargets ?? defaultReadTargets
  const generate = deps.generate ?? generateStructured
  const write = deps.write ?? writeProposals

  // 1. Gate FIRST — short-circuit before any context assembly or model call.
  const count = await countConnected(organizationId, ORG_GATE_USER_ID)
  if (!meetsTemplateGate(count)) return { written: 0, skipped: 'gate' }

  // 2. Usage floor — connecting integrations is necessary but not sufficient;
  // don't recommend until we've actually observed how they work. Building the
  // profile is cheaper than the model call, so this still saves the expensive
  // part for freshly-connected-but-unused orgs.
  const profile = await buildProfile(organizationId)
  if (profile.runCount < MIN_RUNS_FOR_TEMPLATES) return { written: 0, skipped: 'usage' }

  // 3. Assemble grounded context (all org-scoped, in parallel). Dedup covers the
  // catalogue AND all prior proposals (open + dismissed + accepted) so a
  // rejected idea can't quietly regenerate on a later sweep.
  const [context, catalogueTitles, priorTitles, targets] = await Promise.all([
    retrieve(organizationId, profile),
    readCatalogueTitles(organizationId),
    readPriorTitles(organizationId),
    readTargets(organizationId),
  ])

  // 3. ONE bounded structured call.
  const user = buildGenerationUser(profile, renderContext(context), catalogueTitles, targets)
  const raw = await generate({
    system: GENERATION_SYSTEM,
    user,
    schema: PROPOSAL_SCHEMA as unknown as Record<string, unknown>,
    schemaName: 'template_proposals',
    maxTokens: PROPOSAL_MAX_TOKENS,
  })

  let parsed: RawProposal[]
  try {
    parsed = parseProposalsReply(raw)
  } catch {
    return { written: 0, skipped: 'parse' }
  }

  // 4. Validate → dedupe → cap.
  const ctx: NormalizeContext = {
    profile,
    flowIds: new Set(targets.flows.map((f) => f.id)),
    agentIds: new Set(targets.agents.map((a) => a.id)),
  }
  const normalized = parsed
    .map((p) => normalizeProposal(p, ctx))
    .filter((p): p is ProposalInput => p !== null)
  const deduped = dedupeProposals(normalized, [...catalogueTitles, ...priorTitles]).slice(0, MAX_PROPOSALS)

  // 5. Write as OPEN proposals (never a live template).
  const written = await write(organizationId, deduped)
  return { written, skipped: null }
}

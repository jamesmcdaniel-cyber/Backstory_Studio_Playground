/**
 * Usage profile: a structured, org-scoped summary of a workspace's integration
 * activity that the auto-template generation engine (sub-project C) reasons over.
 *
 * Two layers:
 *  - `aggregateUsage` is a PURE, deterministic aggregator over `UsageRow`s
 *    (node:testable without a DB).
 *  - `buildUsageProfile` is a thin, bounded DB read that maps AuditEvent rows
 *    (and, for thin orgs, WorkflowStep rows) into `UsageRow`s and calls it.
 *
 * Provider/tool extraction mirrors how `recordAudit` stores activity:
 *   AuditEvent.resourceType = provider (e.g. 'slack', 'people.ai'), .tool = tool.
 * WorkflowStep.node is the '<provider>.<tool>' encoding written by the agent
 * loop; we split on the LAST dot so providers that contain a dot (e.g.
 * 'people.ai') survive.
 */

import { prisma } from '@/lib/prisma'
import { NANGO_PROVIDER_TOOLS } from '@/lib/nango/provider-tools'
import { listConnectedProviders, type ConnectedProvider } from '@/lib/integrations/connected'

export type UsageRow = { provider: string; tool: string; runId: string | null; at: string }

export type UsageProfile = {
  providers: { provider: string; calls: number }[]
  topTools: { provider: string; tool: string; calls: number }[]
  coOccurrence: { providers: string[]; runs: number }[]
  sequences: { steps: string[]; count: number }[]
  runCount: number
  windowDays: number
  /**
   * Static capability list per CONNECTED Nango provider, independent of whether
   * the org has CALLED the provider —
   * so a freshly-connected integration still contributes signal for a low-run
   * org. Populated by {@link buildUsageProfile}; the pure aggregator leaves it [].
   */
  capabilities: { provider: string; capabilities: string[] }[]
  /**
   * High-level People.ai themes (distinct Sales-AI signal types) when a People.ai
   * connection exists, else []. Populated by {@link buildUsageProfile}.
   */
  themes: string[]
  /**
   * True when the underlying audit read hit {@link MAX_AUDIT_ROWS} and was
   * therefore truncated -- `runCount` (and everything derived from it) reflects
   * only the most-recent {@link MAX_AUDIT_ROWS} events, not the workspace's full
   * history for the window. Consumers that surface `runCount` to a person or a
   * gate MUST say so in plain English rather than presenting a sampled number
   * as a complete one. Always `false` for the pure `aggregateUsage` (it has no
   * notion of a DB-side cap); only {@link buildUsageProfile} can set it `true`.
   */
  sampled: boolean
}

/** Window: last 90 days AND at most the most-recent 500 audit rows (whichever tighter). */
export const USAGE_WINDOW_DAYS = 90
export const MAX_AUDIT_ROWS = 500
/** Recency half-life for provider/tool ranking: usage decays 50% every 30 days. */
export const RECENCY_HALFLIFE_DAYS = 30

/**
 * AuditEvent.action values that represent a GENUINE, EXECUTED tool invocation —
 * the only rows that feed the usage profile.
 *
 *  - 'tool.write' / 'tool.call': a tool executed INLINE. Both executors tag a
 *    real call as 'tool.write' (write/delivery planes) or 'tool.call' (read
 *    planes) — provider-based (see `writePlanes`/`WRITE_PLANES` in
 *    execute-agent.ts:936 / execute-flow.ts:475), so we accept both.
 *  - 'approval.approved': an approval-GATED outbound delivery (Slack/Gmail/
 *    Salesforce) that actually ran. When an agent requires approval, the write
 *    plane short-circuits BEFORE any tool.write (execute-agent.ts:918 /
 *    execute-flow.ts:447 return/continue): the call is queued
 *    ('approval.requested'), and decideApproval later runs the delivery via
 *    spec.run and records ONLY 'approval.approved' (approval.ts:227 —
 *    resourceType=provider e.g. 'nango:slack', tool=the delivery tool). It is
 *    thus the SOLE audit signal for an approved delivery. Approved deliveries
 *    are high-value template signal, so we count them — exactly ONCE, with NO
 *    re-introduced double-count: 'approval.approved' and 'tool.write' are
 *    mutually exclusive per call (a gated call takes the approval path and never
 *    emits tool.write; a non-gated call never emits approval.approved).
 *
 * Everything else is excluded, because it is not an executed tool call:
 *  - 'approval.requested' pairs 1:1 with 'approval.approved' for the same run —
 *    counting it too would re-introduce the double-count. 'approval.rejected' /
 *    'approval.failed' never executed the write.
 *  - resource lifecycle ('flow.published', publish route; config changes;
 *    connects) — not a tool call, and carries a non-provider resourceType
 *    (e.g. 'flow', tool=null) that would surface as a phantom provider.
 * The @@index([organizationId, action]) on AuditEvent makes this filter cheap.
 */
export const TOOL_USAGE_ACTIONS = ['tool.call', 'tool.write', 'approval.approved'] as const
/**
 * Below this many audit rows an org is "thin" and we fold in WorkflowStep-derived
 * rows (from executions not already represented in the audit slice) so few-run
 * orgs still get signal.
 */
export const THIN_AUDIT_ROW_THRESHOLD = 20

const TOP_TOOLS_CAP = 25
const CO_OCCURRENCE_CAP = 25
const SEQUENCES_CAP = 25
/** Cap on distinct People.ai themes folded into the profile. */
export const MAX_THEMES = 25

// Composite map keys are JSON-encoded tuples/arrays: collision-free for any
// provider/tool string, pure-ASCII, and reversible via JSON.parse.
const asc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * PURE aggregation. Deterministic: every output array is sorted desc by count
 * with a secondary sort by the JSON key string so results are stable across any
 * input ordering. Rows with an empty provider are ignored.
 */
export function aggregateUsage(rows: UsageRow[], windowDays: number = USAGE_WINDOW_DAYS): UsageProfile {
  const clean = rows.filter((r) => r.provider)

  // Recency weight: rank by RECENT activity, not just all-window totals, so the
  // profile tracks how the workspace works NOW. Each row decays 50% every
  // RECENCY_HALFLIFE_DAYS relative to the newest row (pure over `rows`, so still
  // deterministic + order-independent). Scores are rounded so tightly-clustered
  // timestamps rank identically to raw counts; only genuinely spread-out usage
  // re-orders. Displayed `calls` stay raw integer counts.
  const atMsList = clean.map((r) => Date.parse(r.at)).filter((t) => Number.isFinite(t))
  const maxAtMs = atMsList.length ? Math.max(...atMsList) : null
  const halfLifeMs = RECENCY_HALFLIFE_DAYS * 86_400_000
  const weightOf = (r: UsageRow): number => {
    if (maxAtMs === null) return 1
    const t = Date.parse(r.at)
    if (!Number.isFinite(t)) return 1
    return Math.pow(2, -(maxAtMs - t) / halfLifeMs)
  }
  const round3 = (n: number): number => Math.round(n * 1000) / 1000

  // providers: rows per provider (+ recency score).
  const providerCounts = new Map<string, number>()
  const providerScores = new Map<string, number>()
  // topTools: rows per (provider, tool), keyed by JSON [provider, tool] (+ score).
  const toolCounts = new Map<string, number>()
  const toolScores = new Map<string, number>()
  // runs: ordered rows per non-null runId.
  const runs = new Map<string, UsageRow[]>()

  for (const r of clean) {
    const w = weightOf(r)
    providerCounts.set(r.provider, (providerCounts.get(r.provider) ?? 0) + 1)
    providerScores.set(r.provider, (providerScores.get(r.provider) ?? 0) + w)
    const toolKey = JSON.stringify([r.provider, r.tool])
    toolCounts.set(toolKey, (toolCounts.get(toolKey) ?? 0) + 1)
    toolScores.set(toolKey, (toolScores.get(toolKey) ?? 0) + w)
    if (r.runId !== null) {
      const bucket = runs.get(r.runId)
      if (bucket) bucket.push(r)
      else runs.set(r.runId, [r])
    }
  }

  const providers = [...providerCounts.entries()]
    .map(([provider, calls]) => ({ provider, calls, score: round3(providerScores.get(provider) ?? 0) }))
    .sort((a, b) => b.score - a.score || b.calls - a.calls || asc(a.provider, b.provider))
    .map(({ provider, calls }) => ({ provider, calls }))

  const topTools = [...toolCounts.entries()]
    .map(([key, calls]) => ({ key, calls, score: round3(toolScores.get(key) ?? 0) }))
    .sort((a, b) => b.score - a.score || b.calls - a.calls || asc(a.key, b.key))
    .slice(0, TOP_TOOLS_CAP)
    .map(({ key, calls }) => {
      const [provider, tool] = JSON.parse(key) as [string, string]
      return { provider, tool, calls }
    })

  // co-occurrence: count runs sharing each distinct-provider SET (size >= 2).
  const setCounts = new Map<string, number>()
  // sequences: count identical distinct-adjacent provider chains (length >= 2).
  const seqCounts = new Map<string, number>()

  for (const bucket of runs.values()) {
    const distinctProviders = [...new Set(bucket.map((r) => r.provider))].sort()
    if (distinctProviders.length >= 2) {
      const setKey = JSON.stringify(distinctProviders)
      setCounts.set(setKey, (setCounts.get(setKey) ?? 0) + 1)
    }

    // Order by `at`, tie-break by provider then tool so a shuffled input of the
    // same rows yields the same chain.
    const ordered = [...bucket].sort(
      (a, b) => asc(a.at, b.at) || asc(a.provider, b.provider) || asc(a.tool, b.tool),
    )
    const chain: string[] = []
    for (const r of ordered) {
      if (chain.length === 0 || chain[chain.length - 1] !== r.provider) chain.push(r.provider)
    }
    if (chain.length >= 2) {
      const seqKey = JSON.stringify(chain)
      seqCounts.set(seqKey, (seqCounts.get(seqKey) ?? 0) + 1)
    }
  }

  const coOccurrence = [...setCounts.entries()]
    .sort((a, b) => b[1] - a[1] || asc(a[0], b[0]))
    .slice(0, CO_OCCURRENCE_CAP)
    .map(([key, runsCount]) => ({ providers: JSON.parse(key) as string[], runs: runsCount }))

  const sequences = [...seqCounts.entries()]
    .sort((a, b) => b[1] - a[1] || asc(a[0], b[0]))
    .slice(0, SEQUENCES_CAP)
    .map(([key, count]) => ({ steps: JSON.parse(key) as string[], count }))

  // capabilities/themes are enrichment layers keyed off CONNECTED providers and
  // People.ai — data the pure aggregator has no access to. buildUsageProfile
  // fills them; here they're empty so aggregateUsage stays a pure fn of `rows`.
  return { providers, topTools, coOccurrence, sequences, runCount: runs.size, windowDays, capabilities: [], themes: [], sampled: false }
}

/**
 * Static capability list for a connected-provider key, or null when we have no
 * catalogued capabilities for it. The Nango provider-tool registry is the source
 * (Granola included, since it gained authored Nango tools). Custom MCP servers
 * (`mcp:*`) have no static catalogue here, so they contribute no capabilities.
 */
function capabilitiesForKey(key: string): string[] | null {
  const catalog = NANGO_PROVIDER_TOOLS.filter((tool) => tool.provider === key).map((tool) => tool.name)
  return catalog.length ? catalog : null
}

/**
 * Map the org's CONNECTED providers to their static capability lists, deduped by
 * the lowercased provider key (a provider connected via two planes yields one
 * capability entry) and sorted for determinism. A freshly-connected provider
 * with ZERO calls still lands here, so the profile is meaningful for low-run orgs.
 */
export function capabilitiesForProviders(
  providers: ConnectedProvider[],
): { provider: string; capabilities: string[] }[] {
  const byKey = new Map<string, string[]>()
  for (const p of providers) {
    const key = p.key.toLowerCase()
    if (byKey.has(key)) continue
    const caps = capabilitiesForKey(key)
    if (caps && caps.length) byKey.set(key, caps)
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => asc(a, b))
    .map(([provider, capabilities]) => ({ provider, capabilities }))
}

const normProvider = (v: string | null | undefined): string => (v ?? '').trim().toLowerCase()
const normTool = (v: string | null | undefined): string => (v ?? '').trim()

/**
 * Split a WorkflowStep.node ('<provider>.<tool>') on the LAST dot. This keeps a
 * dotted provider intact for the common single-token tool (e.g.
 * 'people.ai.get_account' -> provider 'people.ai', tool 'get_account').
 *
 * KNOWN LIMITATION: from the joined string alone, a dotted provider and a dotted
 * TOOL name are ambiguous. An MCP tool whose name contains a dot (e.g.
 * 'slack.chat.postMessage') mis-attributes to provider 'slack.chat'. A robust
 * fix needs an authoritative connected-provider set to match longest-known-prefix
 * against — not reliably available here (this is the THIN-org fallback, used
 * precisely when audit coverage is sparse), and a naive prefix match would risk a
 * NEW mis-split ('people' as a prefix of 'people.ai'). Left as last-dot: the
 * audit path (correct provider/tool split) is the primary source; this fallback
 * only supplies extra signal for few-run orgs. Revisit if MCP dotted tool names
 * become common.
 */
function splitNode(node: string): { provider: string; tool: string } | null {
  const idx = node.lastIndexOf('.')
  if (idx <= 0 || idx === node.length - 1) return null // no dot, or nothing on a side
  return { provider: normProvider(node.slice(0, idx)), tool: normTool(node.slice(idx + 1)) }
}

/**
 * People.ai themes for the org: the DISTINCT Sales-AI signal TYPES it receives
 * (a controlled vocabulary — deal.risk_detected, forecast.updated,
 * stakeholder.engagement_changed, …) that describe what's happening on the org's
 * accounts/opportunities WITHOUT leaking any account name or other PII.
 *
 * Gated on a People.ai connection existing (the brief's "when People.ai present")
 * and bounded to the most-recent {@link MAX_AUDIT_ROWS} signals within the usage
 * window, deduped, sorted, capped at {@link MAX_THEMES}. Returns [] when People.ai
 * is absent, when there are no signals, or on any read error — the enrichment is
 * additive and must never break the profile.
 *
 * We deliberately do NOT source themes from retrieveContext / Sales-AI entity
 * summaries: those return free-text account/opportunity summaries that carry PII
 * (names, deal specifics) and need RAG infra (embeddings + a durable store) live.
 * Signal.type is the bounded, PII-safe, always-available theme source.
 */
async function readThemes(organizationId: string, since: Date): Promise<string[]> {
  try {
    const connection = await prisma.peopleAiConnection.findFirst({
      // Only a live connection counts, matching the canonical "connected"
      // predicate (client.ts drops 'revoked'; entitlement.ts requires 'active').
      // A revoked / refresh_failed connection must not leak historical themes.
      where: { organizationId, status: 'active' },
      select: { id: true },
    })
    if (!connection) return []
    const signals = await prisma.signal.findMany({
      where: { organizationId, receivedAt: { gte: since } },
      orderBy: { receivedAt: 'desc' },
      take: MAX_AUDIT_ROWS,
      select: { type: true },
    })
    const themes = [...new Set(signals.map((s) => s.type).filter((t): t is string => Boolean(t)))]
    themes.sort(asc)
    return themes.slice(0, MAX_THEMES)
  } catch {
    return []
  }
}

/**
 * Capability lists for the org's CONNECTED providers, via the single "connected"
 * source ({@link listConnectedProviders} — org-scoped exactly like
 * /api/integrations/available). Best-effort: any read failure yields [] so the
 * enrichment never blocks the profile.
 */
async function readCapabilities(organizationId: string): Promise<{ provider: string; capabilities: string[] }[]> {
  try {
    // The connected planes are org-visible; listConnectedProviders ignores its
    // userId arg (parity only), so '' means "the whole org, no specific user".
    const connected = await listConnectedProviders(organizationId, '')
    return capabilitiesForProviders(connected)
  } catch {
    return []
  }
}

/**
 * DB wrapper: org-scoped, bounded read of integration activity -> `UsageProfile`.
 *
 * Source of truth is AuditEvent (resourceType = provider, tool = tool, executionId
 * = the run/execution id), restricted to genuine tool-invocation actions
 * ({@link TOOL_USAGE_ACTIONS}) so lifecycle rows do not distort the signal,
 * windowed to the last {@link USAGE_WINDOW_DAYS} days and capped at the
 * most-recent {@link MAX_AUDIT_ROWS} rows (whichever is tighter).
 *
 * When audit coverage is thin ({@link THIN_AUDIT_ROW_THRESHOLD}), we ALSO fold in
 * WorkflowStep rows (node = '<provider>.<tool>') from executions NOT already
 * represented in the audit slice, so few-run orgs still get signal without
 * double-counting the same execution. FlowRunStep is intentionally not read: it
 * carries only a graph nodeId (no provider/tool), and flow tool calls are already
 * captured in AuditEvent (executionId = the flow run id).
 *
 * Two ADDITIVE enrichment layers make the profile meaningful even for a low-run
 * org (both org-scoped, non-blocking, and empty when their source is absent):
 * `capabilities` (what the org's connected providers CAN do, from the registry,
 * regardless of call history) and `themes` (high-level People.ai signal types).
 */
export async function buildUsageProfile(organizationId: string): Promise<UsageProfile> {
  const since = new Date(Date.now() - USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000)

  // Restrict to GENUINE tool-invocation actions (see TOOL_USAGE_ACTIONS): this
  // drops lifecycle rows like flow.published (a phantom 'flow' provider) and the
  // approval.requested/approved rows that would otherwise multi-count a single
  // approval-gated call. The retained tool.call/tool.write is counted once. The
  // action filter also implies a non-null resourceType (both executors always
  // set resourceType=provider on these rows).
  const auditRows = await prisma.auditEvent.findMany({
    where: { organizationId, createdAt: { gte: since }, action: { in: [...TOOL_USAGE_ACTIONS] } },
    orderBy: { createdAt: 'desc' },
    take: MAX_AUDIT_ROWS,
    select: { resourceType: true, tool: true, executionId: true, createdAt: true },
  })

  const rows: UsageRow[] = auditRows
    .map((r) => ({
      provider: normProvider(r.resourceType),
      tool: normTool(r.tool),
      runId: r.executionId ?? null,
      at: r.createdAt.toISOString(),
    }))
    .filter((r) => r.provider)

  // Thin-org fallback: fold in WorkflowStep-derived rows from executions the
  // audit slice does not already cover.
  if (auditRows.length < THIN_AUDIT_ROW_THRESHOLD) {
    const seenRuns = new Set(rows.map((r) => r.runId).filter((id): id is string => id !== null))
    const steps = await prisma.workflowStep.findMany({
      where: { createdAt: { gte: since }, execution: { organizationId } },
      orderBy: { createdAt: 'desc' },
      take: MAX_AUDIT_ROWS,
      select: { node: true, executionId: true, createdAt: true },
    })
    for (const s of steps) {
      if (seenRuns.has(s.executionId)) continue
      const parsed = splitNode(s.node)
      if (!parsed || !parsed.provider || !parsed.tool) continue
      rows.push({ provider: parsed.provider, tool: parsed.tool, runId: s.executionId, at: s.createdAt.toISOString() })
    }
  }

  const base = aggregateUsage(rows, USAGE_WINDOW_DAYS)

  // Enrichment layers, in parallel; each owns its own failure and returns empty,
  // so a missing/failing source degrades to [] rather than breaking the profile.
  const [capabilities, themes] = await Promise.all([
    readCapabilities(organizationId),
    readThemes(organizationId, since),
  ])

  // The audit read is `take: MAX_AUDIT_ROWS` -- hitting that count exactly means
  // there may be MORE rows in the window that were never read, so `runCount`
  // undercounts the true window and callers must say so (see `sampled` above).
  const sampled = auditRows.length >= MAX_AUDIT_ROWS

  return { ...base, capabilities, themes, sampled }
}

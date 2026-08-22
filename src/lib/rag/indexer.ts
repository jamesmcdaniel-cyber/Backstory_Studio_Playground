/**
 * Graph-RAG indexing pipeline.
 *
 * Turns platform data into embedded nodes + typed edges so retrieval can
 * correlate across sources:
 *   - Signals (Sales AI events)          → signal nodes + account/opp/stakeholder nodes + edges
 *   - Executions (runs + tool outputs)   → run nodes carrying MCP/integration results + edges
 *   - Agents                             → agent nodes
 *
 * Everything is best-effort and GATED on embeddings being configured — when
 * VOYAGE_API_KEY is unset these are no-ops, so callers can fire them
 * unconditionally without breaking the hot path. Indexing failures are
 * swallowed (logged) and never propagate to the triggering request/run.
 */

import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { getPeopleAiReadClient } from '@/lib/peopleai/client'
import { enrichAccount, enrichOpportunity } from '@/lib/peopleai/salesai-facts'
import { embedTexts } from './embeddings'
import { getGraphRagStore, graphRagPersistent, ragEnabled } from './get-store'
import type { EdgeRelation, GraphEdge, GraphNode, NodeType, NodeVisibility } from './store'

// ── Node id scheme (stable, so re-indexing upserts in place) ─────────────────
export const nodeIds = {
  account: (id: string) => `account:${id}`,
  opportunity: (id: string) => `opp:${id}`,
  stakeholder: (id: string) => `stakeholder:${id}`,
  signal: (id: string) => `signal:${id}`,
  run: (id: string) => `run:${id}`,
  agent: (id: string) => `agent:${id}`,
  activity: (id: string) => `activity:${id}`,
}
const nid = nodeIds

export interface PendingNode {
  id: string
  type: NodeType
  text: string
  props: Record<string, unknown>
  /** Owner for per-rep scoping; omit/null for org-shared data. */
  ownerUserId?: string | null
  /** Defaults to 'shared' when omitted. */
  visibility?: NodeVisibility
}

/** Embed pending nodes in one batch and persist nodes + edges. Reused by backfill. */
export async function commitGraph(organizationId: string, nodes: PendingNode[], edges: GraphEdge[]): Promise<void> {
  return commit(organizationId, nodes, edges)
}

/** Embed pending nodes in one batch and persist nodes + edges. */
async function commit(organizationId: string, nodes: PendingNode[], edges: GraphEdge[]): Promise<void> {
  if (!ragEnabled() || nodes.length === 0) return
  const store = getGraphRagStore()
  const embeddings = await embedTexts(nodes.map((n) => n.text), { inputType: 'document' })
  const graphNodes: GraphNode[] = nodes.map((n, i) => ({
    id: n.id,
    organizationId,
    type: n.type,
    text: n.text,
    props: n.props,
    embedding: embeddings[i] ?? [],
    ownerUserId: n.ownerUserId ?? null,
    visibility: n.visibility ?? 'shared',
    updatedAt: new Date().toISOString(),
  }))
  await store.upsertNodes(graphNodes)
  if (edges.length) await store.upsertEdges(edges)
}

// Entity nodes referenced by a signal/run. Text is minimal today (the id);
// SEAM: enrich account/opportunity/stakeholder text with People.ai facts via
// getPeopleAiReadClient once the SalesAI read tool names are wired.
function entityNodesFor(
  refs: { accountId?: string | null; opportunityId?: string | null; stakeholderId?: string | null },
): { nodes: PendingNode[]; edgesFromSignal: Array<{ to: string; rel: EdgeRelation }>; belongsTo: GraphEdge[] } {
  const nodes: PendingNode[] = []
  const edgesFromSignal: Array<{ to: string; rel: EdgeRelation }> = []
  const belongsTo: GraphEdge[] = []

  if (refs.accountId) {
    nodes.push({ id: nid.account(refs.accountId), type: 'account', text: `Account ${refs.accountId}`, props: { accountId: refs.accountId } })
    edgesFromSignal.push({ to: nid.account(refs.accountId), rel: 'about_account' })
  }
  if (refs.opportunityId) {
    nodes.push({ id: nid.opportunity(refs.opportunityId), type: 'opportunity', text: `Opportunity ${refs.opportunityId}`, props: { opportunityId: refs.opportunityId } })
    edgesFromSignal.push({ to: nid.opportunity(refs.opportunityId), rel: 'about_opportunity' })
  }
  if (refs.stakeholderId) {
    nodes.push({ id: nid.stakeholder(refs.stakeholderId), type: 'stakeholder', text: `Stakeholder ${refs.stakeholderId}`, props: { stakeholderId: refs.stakeholderId } })
    edgesFromSignal.push({ to: nid.stakeholder(refs.stakeholderId), rel: 'about_stakeholder' })
  }
  return { nodes, edgesFromSignal, belongsTo }
}

export interface SignalRecord {
  id: string
  organizationId: string
  type: string
  accountId: string | null
  opportunityId: string | null
  stakeholderId: string | null
  payload: unknown
}

export async function indexSignal(signal: SignalRecord): Promise<void> {
  if (!ragEnabled()) return
  try {
    const org = signal.organizationId
    const payloadText = safeJson(signal.payload).slice(0, 1500)
    const nodes: PendingNode[] = [
      {
        id: nid.signal(signal.id), type: 'signal',
        text: `Sales AI signal: ${signal.type}. ${payloadText}`,
        props: { signalType: signal.type, accountId: signal.accountId, opportunityId: signal.opportunityId },
      },
    ]
    const edges: GraphEdge[] = []
    const { nodes: entityNodes, edgesFromSignal } = entityNodesFor(signal)
    nodes.push(...entityNodes)
    for (const e of edgesFromSignal) edges.push({ organizationId: org, from: nid.signal(signal.id), to: e.to, rel: e.rel })
    if (signal.accountId && signal.opportunityId) {
      edges.push({ organizationId: org, from: nid.opportunity(signal.opportunityId), to: nid.account(signal.accountId), rel: 'belongs_to' })
    }
    // Enrich account/opportunity nodes with live Sales AI intelligence (status,
    // risks, next steps) so the graph carries substance, not just ids. Native
    // service client; best-effort — a failure leaves the basic node.
    await enrichEntities(org, signal.accountId, signal.opportunityId, nodes)
    await commit(org, nodes, edges)
  } catch (error) {
    warn('indexSignal', error)
  }
}

/** Replace basic account/opp node text with Sales AI facts, in place. */
async function enrichEntities(
  organizationId: string,
  accountId: string | null,
  opportunityId: string | null,
  nodes: PendingNode[],
): Promise<void> {
  if (!accountId && !opportunityId) return
  const client = await getPeopleAiReadClient(null, organizationId)
  if (!client) return
  // Cache scope = the identity the read client uses. getPeopleAiReadClient(null,
  // org) resolves to the org-wide service client, so account/opp facts are the
  // shared org view — safe to cache per org (matches the isolation posture).
  const cacheScope = `org:${organizationId}`
  try {
    if (accountId) {
      const facts = await enrichAccount(client, accountId, { cacheScope })
      const node = nodes.find((n) => n.id === nid.account(accountId))
      if (facts && node) {
        node.text = `Account ${accountId} — Sales AI status: ${facts.text}`
        node.props = { ...node.props, peopleaiAccountId: facts.peopleaiId }
      }
    }
    if (opportunityId) {
      const facts = await enrichOpportunity(client, opportunityId, { cacheScope })
      const node = nodes.find((n) => n.id === nid.opportunity(opportunityId))
      if (facts && node) {
        node.text = `Opportunity ${opportunityId} — Sales AI status: ${facts.text}`
        node.props = { ...node.props, peopleaiOpportunityId: facts.peopleaiId }
      }
    }
  } catch (error) {
    warn('enrichEntities', error)
  }
}

export interface ExecutionRecord {
  id: string
  organizationId: string
  agentTaskId: string | null
  agentTitle?: string | null
  signalId: string | null
  input: unknown
  output: unknown
  status: string
  toolSummaries?: string[]
  /** Owner of the run node — the run's agent owner, so runs inherit agent scope. */
  ownerUserId?: string | null
  /** Run visibility; inherits the agent's visibility. Defaults to 'shared'. */
  visibility?: NodeVisibility
}

export async function indexExecution(execution: ExecutionRecord): Promise<void> {
  if (!ragEnabled()) return
  try {
    const org = execution.organizationId
    const outputText = outputSummary(execution.output).slice(0, 1500)
    const tools = execution.toolSummaries?.length ? ` Tools: ${execution.toolSummaries.join('; ')}.` : ''
    const nodes: PendingNode[] = [
      {
        id: nid.run(execution.id), type: 'run',
        text: `Agent run (${execution.status}) for "${execution.agentTitle ?? execution.agentTaskId ?? 'agent'}".${tools} Output: ${outputText}`,
        props: { status: execution.status, agentTaskId: execution.agentTaskId },
        ownerUserId: execution.ownerUserId ?? null,
        visibility: execution.visibility ?? 'shared',
      },
    ]
    const edges: GraphEdge[] = []
    if (execution.agentTaskId) {
      edges.push({ organizationId: org, from: nid.run(execution.id), to: nid.agent(execution.agentTaskId), rel: 'ran_agent' })
    }
    if (execution.signalId) {
      edges.push({ organizationId: org, from: nid.signal(execution.signalId), to: nid.run(execution.id), rel: 'triggered_run' })
    }
    // Correlate the run to the account/opp carried on its triggering signal input.
    const signal = (execution.input as { signal?: { accountId?: string; opportunityId?: string } } | null)?.signal
    if (signal?.accountId) edges.push({ organizationId: org, from: nid.run(execution.id), to: nid.account(signal.accountId), rel: 'about_account' })
    if (signal?.opportunityId) edges.push({ organizationId: org, from: nid.run(execution.id), to: nid.opportunity(signal.opportunityId), rel: 'about_opportunity' })
    await commit(org, nodes, edges)
  } catch (error) {
    warn('indexExecution', error)
  }
}

export interface AgentRecord {
  id: string
  organizationId: string
  title: string
  objective: string | null
  description: string | null
  /** Agent owner; scopes the agent node per rep. */
  ownerUserId?: string | null
  /** 'private' hides the agent (and its runs) from other reps. Defaults to 'shared'. */
  visibility?: NodeVisibility
}

export async function indexAgent(agent: AgentRecord): Promise<void> {
  if (!ragEnabled()) return
  try {
    await commit(
      agent.organizationId,
      [{
        id: nid.agent(agent.id), type: 'agent',
        text: `Agent "${agent.title}". ${agent.description ?? ''} Objective: ${agent.objective ?? ''}`.slice(0, 1200),
        props: { agentId: agent.id, title: agent.title },
        ownerUserId: agent.ownerUserId ?? null,
        visibility: agent.visibility ?? 'shared',
      }],
      [],
    )
  } catch (error) {
    warn('indexAgent', error)
  }
}

/**
 * Index a custom-signal run (a rep's saved SalesAI question + its answer) as a
 * private insight node linked to the account/opportunity, so agents and the
 * assistant can correlate on it. Best-effort; gated on embeddings.
 */
export async function indexCustomSignalResult(params: {
  organizationId: string
  ownerUserId: string
  signalId: string
  name: string
  question: string
  answer: string
  accountId?: string | null
  opportunityId?: string | null
}): Promise<void> {
  if (!ragEnabled()) return
  try {
    const target = params.accountId ?? params.opportunityId ?? 'x'
    const nodeId = `insight:sig:${params.signalId}:${target}`
    const text = `Custom signal "${params.name}" — Q: ${params.question} — A: ${params.answer}`.slice(0, 1800)
    // Only the private insight node is written. We deliberately do NOT push
    // bare account/opportunity nodes here: upsertNodes is a full-replace, so a
    // bare node would clobber the richer SHARED entity node written by
    // enrichEntities (Sales AI status) for the whole org. The edge links to the
    // existing entity when present (a no-op if it isn't yet indexed).
    const nodes: PendingNode[] = [{
      id: nodeId, type: 'insight', text,
      props: { signalId: params.signalId, name: params.name },
      // The rep's own signal result — private to them (matches isolation posture).
      ownerUserId: params.ownerUserId, visibility: 'private',
    }]
    const edges: GraphEdge[] = []
    if (params.accountId) {
      edges.push({ organizationId: params.organizationId, from: nodeId, to: nid.account(params.accountId), rel: 'about_account' })
    }
    if (params.opportunityId) {
      edges.push({ organizationId: params.organizationId, from: nodeId, to: nid.opportunity(params.opportunityId), rel: 'about_opportunity' })
    }
    await commitGraph(params.organizationId, nodes, edges)
  } catch (error) {
    warn('indexCustomSignalResult', error)
  }
}

/**
 * Index an agent memory (a learned fact, user answer, or suggestion the agent
 * accumulated) as a shared insight node linked to its agent, so retrieval can
 * surface it alongside runs and signals for that agent. Best-effort; gated on
 * embeddings.
 */
export async function indexAgentMemory(params: {
  memoryId: string
  organizationId: string
  agentId: string
  kind: string
  title: string
  content: string
  ownerUserId?: string | null
  visibility?: NodeVisibility
}): Promise<void> {
  if (!ragEnabled()) return
  try {
    const nodeId = `insight:mem:${params.memoryId}`
    const text = `Agent memory (${params.kind}): ${params.title}. ${params.content}`.slice(0, 1500)
    const nodes: PendingNode[] = [{
      id: nodeId, type: 'insight', text,
      props: { kind: params.kind, agentId: params.agentId },
      // Inherit the owning agent's scope, mirroring the run node — a private
      // agent's learned facts must not surface to other reps via org search.
      ownerUserId: params.ownerUserId ?? null, visibility: params.visibility ?? 'shared',
    }]
    const edges: GraphEdge[] = [
      { organizationId: params.organizationId, from: nodeId, to: nid.agent(params.agentId), rel: 'belongs_to' },
    ]
    await commitGraph(params.organizationId, nodes, edges)
  } catch (error) {
    warn('indexAgentMemory', error)
  }
}

/**
 * Remove an agent and its run nodes from the graph when the agent is deleted,
 * so its (possibly stale) content can't resurface in retrieval or LLM context.
 * Best-effort; only meaningful for the persistent (Neo4j) store.
 */
export async function removeAgentFromGraph(organizationId: string, agentId: string): Promise<void> {
  if (!graphRagPersistent()) return
  try {
    const execs = await prisma.agentExecution.findMany({
      where: { organizationId, agentTaskId: agentId }, select: { id: true },
    })
    const ids = [nid.agent(agentId), ...execs.map((e) => nid.run(e.id))]
    await getGraphRagStore().deleteNodes(organizationId, ids)
  } catch (error) {
    warn('removeAgentFromGraph', error)
  }
}

/** Remove a single run node when its execution is deleted. Best-effort. */
export async function removeExecutionFromGraph(organizationId: string, executionId: string): Promise<void> {
  if (!graphRagPersistent()) return
  try {
    await getGraphRagStore().deleteNodes(organizationId, [nid.run(executionId)])
  } catch (error) {
    warn('removeExecutionFromGraph', error)
  }
}

/**
 * Bulk graph cleanup for the retention job: delete the run:/signal: nodes for
 * rows Postgres is about to (or just did) prune, grouped per org because the
 * store API scopes deletes by organizationId. Best-effort — retention must
 * never fail on graph cleanup; a missed node is re-swept the next day only if
 * ids are still known, so callers should delete graph-first or tolerate loss.
 */
export async function removeRetiredFromGraph(
  groups: Array<{ organizationId: string; executionIds: string[]; signalIds: string[]; activityIds?: string[] }>,
): Promise<void> {
  if (!graphRagPersistent()) return
  const store = getGraphRagStore()
  for (const group of groups) {
    const ids = [
      ...group.executionIds.map((id) => nid.run(id)),
      ...group.signalIds.map((id) => nid.signal(id)),
      ...(group.activityIds ?? []).map((id) => nid.activity(id)),
    ]
    if (ids.length === 0) continue
    try {
      await store.deleteNodes(group.organizationId, ids)
    } catch (error) {
      warn('removeRetiredFromGraph', error)
    }
  }
}

function safeJson(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value ?? {})
  } catch {
    return ''
  }
}

/**
 * Human-readable text for a run's output. Agent outputs are typically
 * `{ summary, response, ... }` blobs — retrieval facts built from raw
 * JSON.stringify read as escaped noise in the correlated-context UI, so prefer
 * the summary/response string and only fall back to JSON for unknown shapes.
 * (Mirrors resultText() in the dashboard's activity pane.)
 */
function outputSummary(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const blob = value as { summary?: unknown; response?: unknown }
    if (typeof blob.summary === 'string' && blob.summary.trim()) return blob.summary
    if (typeof blob.response === 'string' && blob.response.trim()) return blob.response
  }
  return safeJson(value)
}

function warn(scope: string, error: unknown): void {
  apiLogger.warn(`rag.${scope} failed`, { error: error instanceof Error ? error.message : String(error) })
}

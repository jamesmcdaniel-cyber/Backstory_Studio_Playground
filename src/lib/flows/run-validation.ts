/**
 * "Can this graph still run against what the workspace looks like RIGHT NOW?"
 *
 * A flow graph is validated in three places that must agree: at publish, when
 * a run starts, and when a paused run is resumed. They were three copies of
 * the same three queries, which is how the resume path came to answer the
 * question in a worker nobody was watching — a reply to a run whose graph no
 * longer validated was accepted, dispatched, and silently dropped.
 *
 * The reference the run executes is PINNED (`FlowRun.graphSnapshot`), but the
 * things it points AT are not: an agent step still names an agent that may
 * since have been deleted. So a snapshot that validated at start can stop
 * validating later, and nothing about editing the flow afterwards changes
 * that — the snapshot is what resumes.
 */

import { prisma } from '@/lib/prisma'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { loadFlowToolCatalog, type FlowToolCatalogConnection } from '@/lib/flows/tool-catalog'
import { validateFlowGraph, type FlowValidationResult } from '@/lib/flows/validate'
import type { flowGraphSchema } from '@/lib/flows/graph'
import { credentialOwnerLabel, httpCredentialUsableBy } from '@/lib/credentials/http-credential-owner'

type FlowGraph = ReturnType<typeof flowGraphSchema.parse>

export interface RunValidationContext {
  /**
   * Full rows — the execution manifest is built from these, not from
   * agentRefs. Carries the fields that define what the agent DOES (live and
   * published), so the manifest can pin a config revision rather than the
   * run-bumped `updatedAt`.
   */
  agents: {
    id: string
    description: string
    objective: string
    goal: string | null
    context: unknown
    schedule: unknown
    metadata: unknown
    publishedConfig: unknown
  }[]
  /** The shape validateFlowGraph wants. */
  agentRefs: { id: string; title: string }[]
  toolCatalog: FlowToolCatalogConnection[]
  /** `foreignOwner` is set when the credential is another member's personal one: the run may not use it. */
  httpCredentials: { id: string; host?: string; foreignOwner?: string }[]
  credentialResolvers: { id: string }[]
}

export interface RunValidationScope {
  organizationId: string
  /** Whose visibility decides which agents/connections count as available. */
  userId: string
  flowId?: string
  /**
   * Who the run will ACT as, for whose HTTP credentials it may use; defaults
   * to `userId`. Publishing passes the flow's owner, because the published
   * schedule/webhook/poll runs act as the owner, not as whoever published.
   */
  credentialUserId?: string
}

/** Connections and credentials this graph actually references — nothing else is fetched. */
function referencedIds(graph: FlowGraph, options: RunValidationOptions = {}) {
  const connectionIds = new Set<string>()
  const credentialIds = new Set<string>()
  const credentialResolverIds = new Set<string>()
  for (const node of graph.nodes) {
    // A polling trigger calls a tool too. Only publish asks about it (see
    // checkPollTool): a run or resume never polls, so it doesn't load it.
    if (node.type === 'trigger' && options.includePollTrigger) {
      const trigger = node.data.trigger as { type?: unknown; connectionId?: unknown } | undefined
      if (trigger?.type === 'poll' && typeof trigger.connectionId === 'string' && trigger.connectionId.trim()) {
        connectionIds.add(trigger.connectionId.trim())
      }
    }
    if (node.type === 'tool' || node.type === 'http') {
      if (node.data.connectionId) connectionIds.add(node.data.connectionId)
    }
    if (node.type === 'agent') {
      for (const id of node.data.toolConnectionIds ?? []) if (id) connectionIds.add(id)
    }
    if (node.type === 'http' && node.data.credentialId) credentialIds.add(node.data.credentialId)
    if (node.type === 'http' && node.data.credentialResolverId) credentialResolverIds.add(node.data.credentialResolverId)
  }
  return { connectionIds: [...connectionIds], credentialIds: [...credentialIds], credentialResolverIds: [...credentialResolverIds] }
}

export interface RunValidationOptions {
  /** Also load the polling trigger's connection (publish validation). */
  includePollTrigger?: boolean
}

export async function loadRunValidationContext(
  graph: FlowGraph,
  scope: RunValidationScope,
  options: RunValidationOptions = {},
): Promise<RunValidationContext> {
  const { connectionIds, credentialIds, credentialResolverIds } = referencedIds(graph, options)
  const agentIds = [...new Set(graph.nodes.flatMap(node => node.type === 'agent' ? [node.data.agentId] : []))]
  const [agents, toolCatalog, httpCredentials, credentialResolvers] = await Promise.all([
    agentIds.length ? prisma.agentTask.findMany({
      where: { organizationId: scope.organizationId, id: { in: agentIds }, status: 'ACTIVE', ...agentVisibilityScope(scope.userId) },
      select: { id: true, description: true, objective: true, goal: true, context: true, schedule: true, metadata: true, publishedConfig: true },
    }) : Promise.resolve([]),
    connectionIds.length
      ? loadFlowToolCatalog(scope.organizationId, {
          userId: scope.userId,
          connectionIds,
          takeConnections: connectionIds.length,
          takeTools: 100,
        })
      : Promise.resolve([]),
    credentialIds.length
      ? prisma.httpCredential.findMany({
          where: { organizationId: scope.organizationId, id: { in: credentialIds }, status: { in: ['verified', 'error'] } },
          select: { id: true, userId: true, allowedHost: true, user: { select: { name: true, email: true } } },
        })
      : Promise.resolve([]),
    credentialResolverIds.length
      ? prisma.credentialResolver.findMany({
          where: { organizationId: scope.organizationId, id: { in: credentialResolverIds }, status: 'active' },
          select: { id: true },
        })
      : Promise.resolve([]),
  ])
  return {
    agents,
    agentRefs: agents.map((agent) => ({ id: agent.id, title: agent.description })),
    toolCatalog,
    // The same owner rule the runtime enforces (resolveHttpCredential with
    // runnerOwned), checked before the run starts so it fails with the fix
    // rather than mid-run.
    httpCredentials: httpCredentials.map((row) => ({
      id: row.id,
      host: row.allowedHost,
      ...(httpCredentialUsableBy(row, scope.credentialUserId ?? scope.userId) ? {} : { foreignOwner: credentialOwnerLabel(row.user) }),
    })),
    credentialResolvers,
  }
}

/**
 * Load the context and validate in one step. Returns the context too, because
 * the run path needs the same agent rows to build its execution manifest —
 * loading them twice is how the two could disagree.
 */
export async function validateGraphForRun(
  graph: FlowGraph,
  scope: RunValidationScope,
): Promise<{ validation: FlowValidationResult; context: RunValidationContext }> {
  const context = await loadRunValidationContext(graph, scope)
  const validation = validateFlowGraph(graph, {
    agents: context.agentRefs,
    toolCatalog: context.toolCatalog,
    httpCredentials: context.httpCredentials,
    credentialResolvers: context.credentialResolvers,
    ...(scope.flowId ? { flowId: scope.flowId } : {}),
  })
  return { validation, context }
}

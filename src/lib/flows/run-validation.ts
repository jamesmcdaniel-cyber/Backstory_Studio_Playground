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

type FlowGraph = ReturnType<typeof flowGraphSchema.parse>

export interface RunValidationContext {
  /** Full rows — the execution manifest is built from these, not from agentRefs. */
  agents: { id: string; description: string; updatedAt: Date }[]
  /** The shape validateFlowGraph wants. */
  agentRefs: { id: string; title: string }[]
  toolCatalog: FlowToolCatalogConnection[]
  httpCredentials: { id: string }[]
}

export interface RunValidationScope {
  organizationId: string
  /** Whose visibility decides which agents/connections count as available. */
  userId: string
  flowId?: string
}

/** Connections and credentials this graph actually references — nothing else is fetched. */
function referencedIds(graph: FlowGraph) {
  const connectionIds = new Set<string>()
  const credentialIds = new Set<string>()
  for (const node of graph.nodes) {
    if (node.type === 'tool' || node.type === 'http') {
      if (node.data.connectionId) connectionIds.add(node.data.connectionId)
    }
    if (node.type === 'agent') {
      for (const id of node.data.toolConnectionIds ?? []) if (id) connectionIds.add(id)
    }
    if (node.type === 'http' && node.data.credentialId) credentialIds.add(node.data.credentialId)
  }
  return { connectionIds: [...connectionIds], credentialIds: [...credentialIds] }
}

export async function loadRunValidationContext(
  graph: FlowGraph,
  scope: RunValidationScope,
): Promise<RunValidationContext> {
  const { connectionIds, credentialIds } = referencedIds(graph)
  const [agents, toolCatalog, httpCredentials] = await Promise.all([
    prisma.agentTask.findMany({
      where: { organizationId: scope.organizationId, status: 'ACTIVE', ...agentVisibilityScope(scope.userId) },
      select: { id: true, description: true, updatedAt: true },
      take: 500,
    }),
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
          select: { id: true },
        })
      : Promise.resolve([]),
  ])
  return {
    agents,
    agentRefs: agents.map((agent) => ({ id: agent.id, title: agent.description })),
    toolCatalog,
    httpCredentials,
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
    ...(scope.flowId ? { flowId: scope.flowId } : {}),
  })
  return { validation, context }
}

/**
 * Reading the action ledger: which entries a person may see, and each entry
 * shaped for the UI with an honest undo verdict for THAT person.
 *
 * Visibility follows the thing that acted: a private agent's (or private
 * flow's) entries are its owner's alone, exactly like its runs.
 */

import { prisma } from '@/lib/prisma'
import { agentVisibilityScope, executionVisibilityScope } from '@/lib/server/visibility'
import { compensationFor, type ResultRef } from '@/lib/nango/compensators'
import { humanizeToolName } from '@/lib/mcp/tool-policy'
import type { AgentActionStatus, AgentActionView } from './action-ledger-types'

export type LedgerFilter = { agentId?: string; flowId?: string; runId?: string }

type Viewer = { organizationId: string; userId: string; canManageIntegrations: boolean }

/** The `where` for a filter the viewer may read, or null when they may not. */
export async function visibleLedgerWhere(viewer: Viewer, filter: LedgerFilter): Promise<Record<string, unknown> | null> {
  const { organizationId, userId } = viewer
  if (filter.agentId) {
    const agent = await prisma.agentTask.findFirst({ where: { id: filter.agentId, organizationId, ...agentVisibilityScope(userId) }, select: { id: true } })
    return agent ? { organizationId, agentTaskId: agent.id } : null
  }
  if (filter.flowId) {
    const flow = await prisma.flow.findFirst({ where: { id: filter.flowId, organizationId, ...agentVisibilityScope(userId) }, select: { id: true } })
    return flow ? { organizationId, flowId: flow.id } : null
  }
  if (filter.runId) {
    const execution = await prisma.agentExecution.findFirst({ where: { id: filter.runId, organizationId, ...executionVisibilityScope(userId) }, select: { id: true } })
    if (execution) return { organizationId, runId: execution.id }
    const run = await prisma.flowRun.findFirst({ where: { id: filter.runId, organizationId }, select: { id: true, flowId: true } })
    if (!run) return null
    const flow = await prisma.flow.findFirst({ where: { id: run.flowId, organizationId, ...agentVisibilityScope(userId) }, select: { id: true } })
    return flow ? { organizationId, runId: run.id } : null
  }
  return null
}

/** May this viewer see this one entry? (For the undo route.) */
export async function entryVisibleTo(viewer: Viewer, entry: { agentTaskId: string | null; flowId: string | null; runId: string }): Promise<boolean> {
  if (entry.agentTaskId) return Boolean(await visibleLedgerWhere(viewer, { agentId: entry.agentTaskId }))
  if (entry.flowId) return Boolean(await visibleLedgerWhere(viewer, { flowId: entry.flowId }))
  return Boolean(await visibleLedgerWhere(viewer, { runId: entry.runId }))
}

type ConnectionRef = { actsAs?: string | null; nango?: { connectionId?: string } }

export async function listLedgerEntries(viewer: Viewer, where: Record<string, unknown>, options: { take?: number; cursor?: string } = {}) {
  const take = Math.min(Math.max(options.take ?? 50, 1), 100)
  const rows = await prisma.agentAction.findMany({
    where: { ...where, organizationId: viewer.organizationId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: take + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  })
  const page = rows.slice(0, take)
  const userIds = [...new Set(page.flatMap((row) => [row.actorUserId, row.approvedById, row.undoneById]).filter((id): id is string => Boolean(id)))]
  const connectionIds = [...new Set(page.map((row) => (row.connectionRef as ConnectionRef | null)?.nango?.connectionId).filter((id): id is string => Boolean(id)))]
  const [users, connections] = await Promise.all([
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : [],
    connectionIds.length
      ? prisma.nangoConnection.findMany({ where: { organizationId: viewer.organizationId, connectionId: { in: connectionIds } }, select: { connectionId: true, userId: true, status: true } })
      : [],
  ])
  const person = (id: string | null) => {
    if (!id) return null
    const user = users.find((candidate) => candidate.id === id)
    return { id, name: user?.name || user?.email || 'A former member' }
  }
  const items: AgentActionView[] = page.map((row) => {
    const compensation = compensationFor(row)
    const ref = (row.resultRef ?? {}) as ResultRef
    const connectionRef = (row.connectionRef ?? null) as ConnectionRef | null
    let undo: AgentActionView['undo']
    if (!compensation.undoable) {
      undo = { possible: false, allowed: false, reason: compensation.reason }
    } else {
      const missing = compensation.missing?.({ args: {}, ref, before: row.beforeImage })
      if (missing) undo = { possible: false, allowed: false, reason: missing }
      else {
        undo = { possible: true, allowed: true, effect: compensation.effect }
        if (row.provider.startsWith('nango:')) {
          const connection = connections.find((candidate) => candidate.connectionId === connectionRef?.nango?.connectionId)
          if (!connection || connection.status !== 'connected') undo = { ...undo, allowed: false, reason: 'The account this went out on is no longer connected.' }
          else if (connection.userId ? connection.userId !== viewer.userId : !viewer.canManageIntegrations) {
            undo = {
              ...undo,
              allowed: false,
              reason: connection.userId
                ? `Done through ${person(connection.userId)?.name ?? 'someone else'}'s own account — only they can undo it.`
                : 'Done through a workspace connection — undoing it needs permission to manage integrations.',
            }
          }
        } else if (!viewer.canManageIntegrations) {
          undo = { ...undo, allowed: false, reason: 'Done through the workspace bot — undoing it needs permission to manage integrations.' }
        }
      }
    }
    return {
      id: row.id,
      sourceKind: row.sourceKind === 'flow' ? 'flow' : 'agent',
      agentTaskId: row.agentTaskId,
      flowId: row.flowId,
      runId: row.runId,
      actor: person(row.actorUserId),
      approvedBy: person(row.approvedById),
      provider: row.provider,
      plane: row.plane,
      tool: row.tool,
      toolLabel: humanizeToolName(row.tool),
      actsAs: (connectionRef?.actsAs as AgentActionView['actsAs']) ?? null,
      argsSummary: (row.argsSummary ?? {}) as Record<string, unknown>,
      resultRef: (row.resultRef ?? null) as Record<string, unknown> | null,
      status: row.status as AgentActionStatus,
      error: row.error,
      undoError: row.undoError,
      createdAt: row.createdAt.toISOString(),
      undoneAt: row.undoneAt?.toISOString() ?? null,
      undoneBy: person(row.undoneById),
      undo,
    }
  })
  return { items, nextCursor: rows.length > take ? page.at(-1)?.id ?? null : null }
}

import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'

/**
 * Per-agent lifetime run stats for the gallery cards: total runs and the
 * completed/failed/blocked split (the client derives success rate from the
 * split so in-flight runs never dilute it). One groupBy, not a query per agent.
 *
 * 'blocked' is counted apart from both: the run produced its work but could not
 * deliver it through a write integration that never resolved. Folding it into
 * `completed` is what let a workspace read 100% success while nothing was
 * actually being delivered.
 */
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const agents = await prisma.agentTask.findMany({
    where: {
      organizationId: auth.organizationId,
      status: { not: 'DELETED' },
      ...agentVisibilityScope(auth.dbUser.id),
    },
    select: { id: true },
    take: 300,
  })
  const ids = agents.map((agent) => agent.id)
  const kpis: Record<string, { runs: number; completed: number; failed: number; blocked: number }> = {}
  if (ids.length) {
    const grouped = await prisma.agentExecution.groupBy({
      by: ['agentTaskId', 'status'],
      where: { organizationId: auth.organizationId, agentTaskId: { in: ids } },
      _count: { _all: true },
    })
    for (const row of grouped) {
      if (!row.agentTaskId) continue
      const entry = (kpis[row.agentTaskId] ??= { runs: 0, completed: 0, failed: 0, blocked: 0 })
      entry.runs += row._count._all
      if (row.status === 'completed') entry.completed += row._count._all
      if (row.status === 'failed') entry.failed += row._count._all
      if (row.status === 'blocked') entry.blocked += row._count._all
    }
  }
  return { success: true, kpis }
}, { permission: 'agent.read' })

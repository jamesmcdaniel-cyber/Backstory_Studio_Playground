import { prisma } from '@/lib/prisma'
import { deriveFlowOperationalStatus, type FlowOperationalStatus } from '@/lib/flows/operational-status'

/**
 * Load compact runtime state for an already-authorized set of local flow ids.
 * Every query remains tenant-scoped; callers are responsible for deciding
 * which flows the viewer may see before passing ids here.
 */
export async function loadFlowOperationalStatuses(
  organizationId: string,
  flowIds: string[],
): Promise<Map<string, FlowOperationalStatus>> {
  const uniqueIds = [...new Set(flowIds)]
  if (!uniqueIds.length) return new Map()

  const activeRuns = await prisma.flowRun.findMany({
    where: {
      organizationId,
      flowId: { in: uniqueIds },
      status: { in: ['running', 'waiting', 'cancelling'] },
    },
    select: {
      flowId: true,
      status: true,
      // Existence is the queue→running boundary; fetching one tiny row avoids
      // counting an execution's entire step history on every status poll.
      steps: { take: 1, select: { id: true } },
    },
  })
  const activeRunsByFlow = new Map<string, Array<{ status: string; stepCount: number }>>()
  for (const run of activeRuns) {
    const entries = activeRunsByFlow.get(run.flowId) ?? []
    entries.push({ status: run.status, stepCount: run.steps.length })
    activeRunsByFlow.set(run.flowId, entries)
  }

  return new Map(
    uniqueIds.map((flowId) => [
      flowId,
      deriveFlowOperationalStatus(activeRunsByFlow.get(flowId) ?? []),
    ]),
  )
}

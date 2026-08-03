import { systemPrisma } from '@/lib/prisma'

export const STUCK_APPROVAL_TIMEOUT_MS = 30 * 60_000
const MAX_BATCH = 200
const ERROR = 'Approval delivery was interrupted; verify the external system before retrying.'

/**
 * Fail closed when a process dies after pending→approving but before recording
 * the delivery outcome. Retrying automatically could duplicate a non-idempotent
 * write, so linked runs are terminalized with an explicit reconciliation error.
 */
export async function reapStuckApprovals(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STUCK_APPROVAL_TIMEOUT_MS)
  // systemPrisma: global recovery sweep, invoked only by the authenticated cron.
  const stuck = await systemPrisma.approvalRequest.findMany({
    where: { status: 'approving', decidedAt: { lt: cutoff } },
    select: { id: true, executionId: true },
    orderBy: { decidedAt: 'asc' },
    take: MAX_BATCH,
  })
  if (!stuck.length) return 0
  const approvalIds = stuck.map((row) => row.id)
  const executionIds = [...new Set(stuck.map((row) => row.executionId))]
  return systemPrisma.$transaction(async (tx) => {
    const failed = await tx.approvalRequest.updateMany({
      where: { id: { in: approvalIds }, status: 'approving' },
      data: { status: 'failed' },
    })
    if (!failed.count) return 0
    await tx.flowRun.updateMany({
      where: { id: { in: executionIds }, status: 'waiting' },
      data: { status: 'failed', error: ERROR, finishedAt: now, resumeAt: null },
    })
    await tx.flowRunStep.updateMany({
      where: { flowRunId: { in: executionIds }, status: 'waiting' },
      data: { status: 'failed', error: ERROR, finishedAt: now },
    })
    await tx.agentExecution.updateMany({
      where: { id: { in: executionIds }, status: 'waiting_approval' },
      data: { status: 'failed', error: ERROR, completedAt: now },
    })
    return failed.count
  })
}

import { systemPrisma } from '@/lib/prisma'
import { onAgentRunsTerminalized } from '@/lib/agents/run-terminal-effects'
import { onFlowRunsTerminalized } from '@/lib/flows/run-terminal-effects'

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
  const result = await systemPrisma.$transaction(async (tx) => {
    const failed = await tx.approvalRequest.updateMany({
      where: { id: { in: approvalIds }, status: 'approving' },
      data: { status: 'failed' },
    })
    if (!failed.count) return { count: 0, flowRunIds: [] as string[], executionIds: [] as string[] }
    // Read inside the transaction, before the writes, so the follow-up below
    // targets exactly the runs THIS sweep moved.
    const [flowRuns, executions] = await Promise.all([
      tx.flowRun.findMany({ where: { id: { in: executionIds }, status: 'waiting' }, select: { id: true } }),
      tx.agentExecution.findMany({ where: { id: { in: executionIds }, status: 'waiting_for_approval' }, select: { id: true } }),
    ])
    await tx.flowRun.updateMany({
      where: { id: { in: executionIds }, status: 'waiting' },
      data: { status: 'failed', error: ERROR, finishedAt: now, resumeAt: null },
    })
    await tx.flowRunStep.updateMany({
      where: { flowRunId: { in: executionIds }, status: 'waiting' },
      data: { status: 'failed', error: ERROR, finishedAt: now },
    })
    // The paused agent status is `waiting_for_approval` (run-status.ts). This
    // matched `waiting_approval` — a status no row ever has — so an agent run
    // whose approved write was interrupted stayed paused forever.
    await tx.agentExecution.updateMany({
      where: { id: { in: executionIds }, status: 'waiting_for_approval' },
      data: { status: 'failed', error: ERROR, completedAt: now },
    })
    return { count: failed.count, flowRunIds: flowRuns.map((run) => run.id), executionIds: executions.map((run) => run.id) }
  })
  // After commit: what a failed run owes (other approvals superseded, the
  // owner told, a waiting parent flow woken). Best-effort and idempotent.
  await onFlowRunsTerminalized(result.flowRunIds, 'failed')
  await onAgentRunsTerminalized(result.executionIds, 'failed')
  return result.count
}

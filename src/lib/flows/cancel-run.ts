import { prisma } from '@/lib/prisma'
import { onFlowRunTerminalized } from '@/lib/flows/run-terminal-effects'
import { onAgentRunTerminalized } from '@/lib/agents/run-terminal-effects'

/**
 * Stop one flow run. The caller has already established that the person may
 * (org + flow visibility + flow.run); this only knows how.
 *
 * A `running` run flips to 'cancelling'; the interpreter polls this once per
 * tick (see execute-flow's isCancelled) and aborts, terminalizing the run as
 * 'cancelled' itself. A `waiting` run has no executor polling it — nothing
 * would ever pick up 'cancelling' and finish the job — so it is cancelled
 * immediately here, with its still-open step rows swept in the same
 * transaction, and its follow-up (approvals superseded, a parent subflow
 * woken) run after commit.
 *
 * Returns the status the run moved to, or null when it was in neither state
 * (already finished, or already cancelling).
 */
export async function cancelFlowRun(params: {
  organizationId: string
  flowId: string
  flowRunId: string
}): Promise<'cancelled' | 'cancelling' | null> {
  const { organizationId, flowId, flowRunId } = params
  // A waiting run completes the cancellation itself: there is no executor to
  // hand `cancelling` off to, so leaving it there would be a permanent dead
  // end. Try this branch first so a waiting run never falls through into the
  // 'cancelling' handoff below.
  //
  // The flip and the step sweep run inside one interactive transaction — the
  // same per-pair atomicity shape as the reaper (see src/lib/flows/reap.ts):
  // a crash between the two statements must never land a `cancelled` run
  // with its steps still `running`/`waiting` forever, since a `cancelled`
  // run's status guard means nothing revisits it to clean up steps it left
  // behind.
  const waitingResult = await prisma.$transaction(async (tx) => {
    const claimed = await tx.flowRun.updateMany({
      where: { id: flowRunId, flowId, organizationId, status: 'waiting' },
      data: { status: 'cancelled', finishedAt: new Date(), resumeAt: null },
    })
    if (claimed.count === 0) return { count: 0, agentExecutionIds: [] as string[] }
    // The paused agent executions behind this run's agent steps: read before
    // the sweep below closes the rows that name them.
    const open = await tx.flowRunStep.findMany({
      where: { flowRunId, status: { in: ['running', 'waiting'] }, agentExecutionId: { not: null } },
      select: { agentExecutionId: true },
    })
    await tx.flowRunStep.updateMany({
      where: { flowRunId, status: { in: ['running', 'waiting'] } },
      data: { status: 'cancelled', finishedAt: new Date() },
    })
    return { count: claimed.count, agentExecutionIds: [...new Set(open.flatMap((step) => step.agentExecutionId ? [step.agentExecutionId] : []))] }
  })
  if (waitingResult.count > 0) {
    // An agent step paused on a question would otherwise keep asking it in
    // the agent's activity pane for a run that has stopped.
    if (waitingResult.agentExecutionIds.length) {
      const moved = await prisma.agentExecution.updateManyAndReturn({
        where: { id: { in: waitingResult.agentExecutionIds }, organizationId, status: { in: ['waiting_for_input', 'waiting_for_approval', 'waiting_for_external'] } },
        data: { status: 'cancelled', completedAt: new Date(), error: null },
        select: { id: true },
      }).catch(() => [] as { id: string }[])
      // Only the executions THIS call moved — one already cancelled by its
      // own route has had its follow-up.
      for (const { id } of moved) {
        await onAgentRunTerminalized({ executionId: id, status: 'cancelled' }, { skipNotify: true })
      }
    }
    // A waiting run is usually waiting ON something: an approval that must
    // not stay approvable for a run that no longer exists, or — for a
    // subflow child — a parent paused on it. Best-effort; never throws.
    await onFlowRunTerminalized({ flowRunId, status: 'cancelled' })
    return 'cancelled'
  }

  // Only a `running` run passes through 'cancelling' — the interpreter's own
  // poll loop terminalizes it. The status guard makes this a no-op (count 0)
  // for a run that's already terminal.
  const result = await prisma.flowRun.updateMany({
    where: { id: flowRunId, flowId, organizationId, status: 'running' },
    data: { status: 'cancelling' },
  })
  return result.count > 0 ? 'cancelling' : null
}

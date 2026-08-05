/**
 * Stuck flow-run recovery. Flows execute inline in serverless/dispatcher
 * processes (no BullMQ job wraps them yet), so a recycled process orphans the
 * FlowRun as `running` forever — and the scheduled-flow overlap guard then
 * skips every future tick for that flow. The cron dispatch tick calls
 * reapStuckFlowRuns() to fail anything running past the budget, mirroring the
 * agent-execution reaper.
 */

import { systemPrisma } from '@/lib/prisma'
import { NEVER_PICKED_UP_TIMEOUT_MS, NEVER_PICKED_UP_ERROR } from '@/lib/flows/run-stall'

// Dispatch/execute routes cap at maxDuration 1200s; 30 min = budget + slack.
export const STUCK_FLOW_RUN_TIMEOUT_MS = 30 * 60 * 1000

const STUCK_RUN_ERROR = 'The run was interrupted and timed out.'
const REAP_BATCH_LIMIT = 500

/**
 * Fail runs stuck `running` past the cutoff (and their still-live steps).
 * Returns the reaped count.
 *
 * `onAfterRead` is a test-only seam: real callers never pass it. It runs
 * after the initial read (so its effects land in the gap the transaction's
 * re-checked `where` clauses are meant to protect against) and lets a test
 * simulate a run legitimately leaving `running` between the read and the
 * write — the exact race this function's re-query step exists to handle.
 */
export async function reapStuckFlowRuns(now = new Date(), onAfterRead?: () => Promise<void>): Promise<number> {
  const cutoff = new Date(now.getTime() - STUCK_FLOW_RUN_TIMEOUT_MS)
  // systemPrisma: global reaper sweep — runs across all orgs by design (invoked from CRON_SECRET-gated dispatch).
  const stuck = await systemPrisma.flowRun.findMany({
    where: { status: 'running', startedAt: { lt: cutoff } },
    select: { id: true },
    take: REAP_BATCH_LIMIT,
  })
  if (stuck.length === 0) return 0
  const runIds = stuck.map((run) => run.id)
  await onAfterRead?.()
  // systemPrisma: global reaper sweep — runs across all orgs by design.
  return systemPrisma.$transaction(async (tx) => {
    // Status re-checked here so a run that legitimately left `running`
    // (e.g. paused for approval) between the read above and this write is
    // left alone.
    const reaped = await tx.flowRun.updateMany({
      where: { id: { in: runIds }, status: 'running' },
      data: { status: 'failed', error: STUCK_RUN_ERROR, finishedAt: now },
    })
    if (reaped.count === 0) return 0
    // Only fail steps belonging to runs THIS pass actually reaped — re-query
    // rather than reuse runIds, since a run this pass skipped (already
    // transitioned away from `running`) must keep its steps untouched.
    const reapedRuns = await tx.flowRun.findMany({
      where: { id: { in: runIds }, status: 'failed', error: STUCK_RUN_ERROR },
      select: { id: true },
    })
    await tx.flowRunStep.updateMany({
      where: { flowRunId: { in: reapedRuns.map((run) => run.id) }, status: { in: ['queued', 'running', 'waiting'] } },
      data: { status: 'failed', error: STUCK_RUN_ERROR, finishedAt: now },
    })
    return reaped.count
  })
}

/**
 * Fast path for the 2026-08-04 outage class: a run `running` with ZERO steps
 * past the pickup window was never consumed by the execution backend (a
 * picked-up run records its first step within seconds), so it fails after
 * ~5 minutes instead of waiting out the 30-minute budget above. Runs WITH
 * steps — however old — are left to reapStuckFlowRuns.
 *
 * `onAfterRead` is the same test-only seam as above: it lets a test land the
 * run's first step in the read→write gap and prove the guarded write spares it.
 */
export async function reapNeverPickedUpRuns(now = new Date(), onAfterRead?: () => Promise<void>): Promise<number> {
  const cutoff = new Date(now.getTime() - NEVER_PICKED_UP_TIMEOUT_MS)
  // systemPrisma: global reaper sweep — runs across all orgs by design (invoked from CRON_SECRET-gated dispatch).
  const stranded = await systemPrisma.flowRun.findMany({
    where: { status: 'running', startedAt: { lt: cutoff }, steps: { none: {} } },
    select: { id: true },
    take: REAP_BATCH_LIMIT,
  })
  if (stranded.length === 0) return 0
  await onAfterRead?.()
  // `status` and `steps: none` re-checked at write time: a run the worker
  // picked up (or that settled) between read and write is spared. No step
  // cleanup needed — matching runs have no steps by definition.
  const reaped = await systemPrisma.flowRun.updateMany({
    where: { id: { in: stranded.map((run) => run.id) }, status: 'running', steps: { none: {} } },
    data: { status: 'failed', error: NEVER_PICKED_UP_ERROR, finishedAt: now },
  })
  return reaped.count
}

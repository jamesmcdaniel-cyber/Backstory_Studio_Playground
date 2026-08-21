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
import { truncateWithMarker } from '@/lib/flows/truncate'

// Dispatch/execute routes cap at maxDuration 1800s; 45 min = budget + slack.
// The cutoff must exceed the route budget or the reaper kills runs that are
// still legitimately executing inside a request.
export const STUCK_FLOW_RUN_TIMEOUT_MS = 45 * 60 * 1000

const REAP_BATCH_LIMIT = 500

// Error-column budget for the reaper's own message (matches the shared
// truncateError default elsewhere in the flow engine) — a pathological node
// name can't blow past what the column is expected to hold.
const REAP_MESSAGE_MAX = 300

/**
 * Build the run-level failure message the reaper writes: what was known,
 * stated plainly, instead of a flat "interrupted and timed out" that hides
 * how far the run actually got. `lastCompletedStepNodeId` is the node id of
 * the most recently succeeded step, or null when the run never completed one
 * (e.g. the never-picked-up case, or a run that died on its very first step).
 */
export function formatReapMessage(startedAt: Date, now: Date, lastCompletedStepNodeId: string | null): string {
  const elapsedMin = Math.max(0, Math.round((now.getTime() - startedAt.getTime()) / 60_000))
  const stepPart = lastCompletedStepNodeId
    ? `last completed step: ${lastCompletedStepNodeId}`
    : 'no step completed before the timeout'
  return truncateWithMarker(`interrupted after ${elapsedMin}m; ${stepPart}`, REAP_MESSAGE_MAX)
}

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
    select: { id: true, startedAt: true },
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
    const stillRunning = await tx.flowRun.findMany({
      where: { id: { in: runIds }, status: 'running' },
      select: { id: true, startedAt: true },
    })
    if (stillRunning.length === 0) return 0
    // Last succeeded step per still-running run, so the failure message can
    // name how far the run actually got instead of a flat "timed out".
    const doneSteps = await tx.flowRunStep.findMany({
      where: { flowRunId: { in: stillRunning.map((run) => run.id) }, status: 'succeeded' },
      select: { flowRunId: true, nodeId: true, finishedAt: true },
      orderBy: { finishedAt: 'desc' },
    })
    const lastStepByRun = new Map<string, string>()
    for (const step of doneSteps) if (!lastStepByRun.has(step.flowRunId)) lastStepByRun.set(step.flowRunId, step.nodeId)

    // Each run gets its own message (elapsed + last step differ per run), so
    // this writes one run at a time rather than a single blanket updateMany —
    // the conditional `status: 'running'` in each where clause is the same
    // race guard the old bulk updateMany used, just applied per row.
    let reapedCount = 0
    for (const run of stillRunning) {
      const message = formatReapMessage(run.startedAt, now, lastStepByRun.get(run.id) ?? null)
      const result = await tx.flowRun.updateMany({
        where: { id: run.id, status: 'running' },
        data: { status: 'failed', error: message, finishedAt: now },
      })
      if (result.count === 0) continue // diverted away from `running` since stillRunning was read
      reapedCount += 1
      await tx.flowRunStep.updateMany({
        where: { flowRunId: run.id, status: { in: ['queued', 'running', 'waiting'] } },
        data: { status: 'failed', error: message, finishedAt: now },
      })
    }
    return reapedCount
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

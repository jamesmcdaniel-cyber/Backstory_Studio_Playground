/**
 * Stuck agent-run recovery, driven by the dispatch tick.
 *
 * A run is reaped when its process stopped beating, not when it gets old. The
 * executor stamps `lastActiveAt` about once a minute while the run's process is
 * alive (src/lib/agents/liveness.ts); one model turn can take 28 minutes and an
 * artifact render longer, so the old rule — fail anything `running` whose
 * startedAt is 30 minutes back — failed healthy runs mid-turn.
 *
 *   - Stale: `running` with no beat for AGENT_STALE_AFTER_MS. The worker
 *     crashed, was redeployed out from under the run, or the inline request
 *     was killed.
 *   - Legacy: `pending` (never claimed, so never beating), or `running` with
 *     no beat ever (a row from before the column, or from a worker that
 *     predates it) — the old 30-minute startedAt rule, unchanged.
 *   - Ceiling: AGENT_RUN_HARD_CEILING_MS since startedAt, beating or not. A
 *     backstop for a run whose process is alive but going nowhere; nothing
 *     legitimate runs this long (resumes refresh startedAt).
 *
 * A late finish wins. When a reaped run's process was in fact still alive (a
 * beat lost to a long event-loop stall, or the ceiling), its own terminal
 * write in execute-agent.ts — keyed by id alone — later overwrites `failed`
 * with `completed` (or with its real error). That is deliberate: the work
 * really did finish, and the run page should say what happened rather than
 * what the reaper guessed. The heartbeat itself never revives a reaped row; it
 * only stamps rows still `running`/`cancelling`.
 */

import { systemPrisma } from '@/lib/prisma'
import { AGENT_RUN_TIMEOUT_MS } from '@/lib/agents/timeouts'
import { AGENT_HEARTBEAT_INTERVAL_MS } from '@/lib/agents/liveness'

/**
 * No beat for this long means the run's process is gone. Ten beats: room for
 * the longest deliberate event-loop block (a 5-minute Pyodide step) plus a
 * slow DB write, with margin.
 */
export const AGENT_STALE_AFTER_MS = 10 * AGENT_HEARTBEAT_INTERVAL_MS

/** Wall-clock backstop for a run that is alive but never finishes. */
export const AGENT_RUN_HARD_CEILING_MS = 2 * 60 * 60 * 1000

/** What a stale run's owner reads. Says what is known — the run stopped reporting — and claims no time limit. */
export const AGENT_STALE_RUN_ERROR =
  'Run stopped responding — the process running it went away (a restart or crash). Retry the run.'
export const AGENT_CEILING_RUN_ERROR = 'Run exceeded the 2-hour limit.'
/** The pre-liveness rule's message, still used for rows that never beat. */
export const AGENT_LEGACY_TIMEOUT_ERROR = 'Run exceeded time limit'

export interface AgentReapSummary {
  stale: number
  legacy: number
  ceiling: number
  cancelled: number
}

/** Fail stuck agent runs; resolve stranded cancels. Returns per-rule counts. */
export async function reapStuckAgentExecutions(now: Date = new Date()): Promise<AgentReapSummary> {
  const staleBefore = new Date(now.getTime() - AGENT_STALE_AFTER_MS)
  const legacyBefore = new Date(now.getTime() - AGENT_RUN_TIMEOUT_MS)
  const ceilingBefore = new Date(now.getTime() - AGENT_RUN_HARD_CEILING_MS)
  const inFlight = { in: ['running', 'pending'] }

  // systemPrisma (all four): global reaper sweep — runs across all orgs by design (CRON_SECRET-gated dispatch tick).
  // Ceiling first, so a run that is both past the ceiling and stale reads as
  // the stronger statement.
  const ceiling = await systemPrisma.agentExecution.updateMany({
    where: { status: inFlight, startedAt: { lt: ceilingBefore } },
    data: { status: 'failed', error: AGENT_CEILING_RUN_ERROR, completedAt: now },
  })
  // startedAt is checked too because a resume refreshes it but not the clock:
  // a run resumed after a long pause carries its old beat until its first
  // new one lands, and must not be reaped in that gap.
  const stale = await systemPrisma.agentExecution.updateMany({
    where: { status: 'running', startedAt: { lt: staleBefore }, lastActiveAt: { lt: staleBefore } },
    data: { status: 'failed', error: AGENT_STALE_RUN_ERROR, completedAt: now },
  })
  // `pending` rows never beat (nothing has claimed them yet), so they stay on
  // the startedAt rule alongside `running` rows that never beat.
  const legacy = await systemPrisma.agentExecution.updateMany({
    where: {
      startedAt: { lt: legacyBefore },
      OR: [{ status: 'pending' }, { status: 'running', lastActiveAt: null }],
    },
    data: { status: 'failed', error: AGENT_LEGACY_TIMEOUT_ERROR, completedAt: now },
  })
  // A user hit cancel and then the process died: resolve it to `cancelled`
  // (it is otherwise un-cancellable and un-deletable). A live run notices a
  // cancel between turns and keeps beating until it does.
  const cancelled = await systemPrisma.agentExecution.updateMany({
    where: {
      status: 'cancelling',
      OR: [
        { startedAt: { lt: staleBefore }, lastActiveAt: { lt: staleBefore } },
        { lastActiveAt: null, startedAt: { lt: legacyBefore } },
        { startedAt: { lt: ceilingBefore } },
      ],
    },
    data: { status: 'cancelled', error: 'Cancelled (run did not stop in time)', completedAt: now },
  })
  return { stale: stale.count, legacy: legacy.count, ceiling: ceiling.count, cancelled: cancelled.count }
}

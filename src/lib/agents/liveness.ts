import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

/**
 * How often a live agent run stamps `lastActiveAt`. The reaper's staleness
 * window (AGENT_STALE_AFTER_MS, src/lib/agents/reap.ts) is several of these,
 * plus the longest the event loop is ever blocked on purpose (a JavaScript
 * code step, 30 s; Python runs on its own thread), so one late beat never
 * reads as a dead run.
 */
export const AGENT_HEARTBEAT_INTERVAL_MS = 60_000

/** The DB edge, injectable so the timer behaviour is testable without Postgres. */
export interface HeartbeatDeps {
  touch: (executionId: string, organizationId: string, at: Date) => Promise<unknown>
  intervalMs: number
}

const defaultDeps = (): HeartbeatDeps => ({
  // Only a run still in flight is stamped: a row the reaper (or anything else)
  // already settled is left settled, and a run paused for input stops beating
  // on its own because its process has moved on.
  touch: (executionId, organizationId, at) =>
    prisma.agentExecution.updateMany({
      where: { id: executionId, organizationId, status: { in: ['running', 'cancelling'] } },
      data: { lastActiveAt: at },
    }),
  intervalMs: AGENT_HEARTBEAT_INTERVAL_MS,
})

/**
 * The liveness signal for one agent run.
 *
 * A timer, not a write per model turn, because a single turn may legitimately
 * take up to AGENT_MODEL_TURN_TIMEOUT_MS (28 minutes) and an artifact render
 * longer still: per-turn stamps would leave exactly the gaps the old
 * startedAt-based reaper misread as a dead run. The timer beats as long as the
 * process running this run is alive and the run has not returned, which is
 * the question the reaper is asking. A hung call is still bounded — by the
 * per-turn timeouts, and by the reaper's hard ceiling.
 *
 * `track` is called once the execution row exists; `stop` when the run
 * settles, however it settles. Never throws: a missed beat is logged, and the
 * next one tries again.
 */
export function startExecutionHeartbeat(organizationId: string, deps: HeartbeatDeps = defaultDeps()) {
  let executionId: string | null = null
  let timer: NodeJS.Timeout | null = null
  const beat = () => {
    if (!executionId) return
    void deps.touch(executionId, organizationId, new Date()).catch((error: unknown) => {
      apiLogger.warn('agent heartbeat write failed', {
        executionId,
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }
  return {
    track(id: string) {
      if (executionId === id) return
      executionId = id
      beat()
      if (!timer) {
        timer = setInterval(beat, deps.intervalMs)
        // Never what keeps a process alive: an exiting worker exits.
        timer.unref?.()
      }
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
      executionId = null
    },
  }
}

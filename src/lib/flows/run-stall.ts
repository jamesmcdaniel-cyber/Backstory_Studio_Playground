/**
 * Never-picked-up detection, shared by the server reaper (reap.ts) and the
 * builder's run poller. A run that is `running` with ZERO recorded steps well
 * past dispatch was never consumed by the execution backend (the 2026-08-04
 * queue-without-consumer outage signature) — distinct from a long legitimate
 * run, which records its first step within seconds of pickup.
 *
 * Client-safe: no Prisma/Redis imports.
 */

export const NEVER_PICKED_UP_TIMEOUT_MS = 5 * 60 * 1000

/**
 * The server-CONFIRMED message: written by the reaper (reap.ts) only once it
 * has actually failed the run under the same guarded re-check every reap
 * write uses. Safe to state as fact — by the time this string lands anywhere,
 * the run really is done.
 */
export const NEVER_PICKED_UP_ERROR =
  'The execution backend never picked up this run. Check worker health (/api/health), then run the flow again.'

/**
 * The client-side, NOT-YET-CONFIRMED message: shown while the builder's own
 * poller suspects (but the server has not yet ruled on) a stalled pickup. A
 * run that looks stalled from here can still resolve — the reaper's window is
 * wider than the client's, and a slow-but-live worker can still claim it — so
 * this reads as a possibility being watched, not a verdict. Polling continues
 * after this fires; only a terminal status from the server stops it.
 */
export const NEVER_PICKED_UP_ADVISORY =
  "This run hasn't been picked up yet — still checking. If it stays this way, check worker health (/api/health)."

export function isRunPickupStalled(
  run: { status: string; startedAt: string | Date; stepCount: number },
  now: number,
): boolean {
  if (run.status !== 'running' || run.stepCount > 0) return false
  const startedAt = new Date(run.startedAt).getTime()
  // Unparseable start time: fail open — the 30-minute reaper still backstops.
  if (!Number.isFinite(startedAt)) return false
  return now - startedAt > NEVER_PICKED_UP_TIMEOUT_MS
}

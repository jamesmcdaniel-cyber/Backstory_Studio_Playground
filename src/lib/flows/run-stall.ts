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

export const NEVER_PICKED_UP_ERROR =
  'The execution backend never picked up this run. Check worker health (/api/health), then run the flow again.'

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

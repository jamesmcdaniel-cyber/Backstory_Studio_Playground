import { getRedisConnection } from '@/lib/queue/config'
import { inlineExecution } from '@/lib/queue/execution-mode'

/**
 * Dispatch-tick liveness. /api/health already reports worker heartbeat
 * freshness, but nothing recorded that the SCHEDULING tick ran — so a Vercel
 * cron that was paused, deleted, or plan-limited stopped every scheduled flow
 * with no signal at all. This is that signal.
 *
 * Distinct from worker:heartbeat: the worker can be perfectly healthy while
 * nothing is dispatching, and the cron can be dispatching with no worker at all.
 * Both facts are worth reporting separately.
 */

export const TICK_LIVENESS_KEY = 'dispatch:tick:last'
/**
 * How old the last tick may be before health reports it stale. The worker
 * drives every 60s and the cron every 15 min; three missed CRON ticks (45 min)
 * means both planes are down, which is the condition worth alerting on. A
 * shorter window would fire during a routine worker redeploy.
 */
export const TICK_STALE_MS = 45 * 60_000

type TickRecord = { at: number; summary?: unknown }

function parse(raw: string | null): TickRecord | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as TickRecord
    return typeof value?.at === 'number' && Number.isFinite(value.at) ? value : null
  } catch {
    return null
  }
}

/** Pure: milliseconds since the last recorded tick, or null when unreadable. */
export function tickAge(raw: string | null, now: number): number | null {
  const record = parse(raw)
  return record ? now - record.at : null
}

/** Pure staleness verdict. Future timestamps (clock skew) count as fresh. */
export function isTickFresh(raw: string | null, now: number, staleMs: number = TICK_STALE_MS): boolean {
  const age = tickAge(raw, now)
  return age !== null && age <= staleMs
}

/** Record a completed tick. Best effort — a Redis failure never fails a tick. */
export async function writeTickLiveness(summary: unknown, now: number = Date.now()): Promise<void> {
  if (inlineExecution) return
  await getRedisConnection()
    .set(TICK_LIVENESS_KEY, JSON.stringify({ at: now, summary }), 'PX', TICK_STALE_MS * 10)
    .catch(() => undefined)
}

/** Read the raw record, bounded so a hung Redis cannot hang the health probe. */
export async function readTickLiveness(timeoutMs = 3_000): Promise<string | null> {
  if (inlineExecution) return null
  return Promise.race([
    getRedisConnection().get(TICK_LIVENESS_KEY),
    new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs)
      if (typeof timer === 'object') timer.unref?.()
    }),
  ]).catch(() => null)
}

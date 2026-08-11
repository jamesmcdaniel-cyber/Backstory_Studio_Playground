import type IORedis from 'ioredis'
import { getRedisConnection } from '@/lib/queue/config'
import { inlineExecution } from '@/lib/queue/execution-mode'

/**
 * Mutual exclusion for the dispatch tick, which now has two callers: the Vercel
 * cron entry in vercel.json and the BullMQ worker's 60s timer (see
 * src/lib/scheduling/dispatch-tick.ts). Without it the two planes would both
 * scan and both dispatch, and the overlap guard they share (blocksSchedule) is
 * a read-then-act check that cannot stop a true race.
 *
 * TTL exceeds the worker interval on purpose: a tick that overruns 60s BLOCKS
 * its successor rather than overlapping it. Release is a compare-and-delete, so
 * a tick that outlived its TTL can never delete the lock a successor now holds.
 */

export const TICK_LOCK_KEY = 'dispatch:tick:lock'
/** 120s: two worker intervals. A tick slower than this yields to its successor. */
export const TICK_LOCK_TTL_MS = 120_000

/** Compare-and-delete: only the holder releases. */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`

type LockRedis = Pick<IORedis, 'set' | 'eval'>

/** Testable core: the lock protocol against an injected client. */
export async function runWithLock<T>(
  redis: LockRedis,
  token: string,
  fn: () => Promise<T>,
): Promise<T | { skipped: 'locked' }> {
  const acquired = await redis.set(TICK_LOCK_KEY, token, 'PX', TICK_LOCK_TTL_MS, 'NX')
  if (acquired !== 'OK') return { skipped: 'locked' }
  try {
    return await fn()
  } finally {
    // Best effort: a failed release just means the lock ages out on its TTL,
    // costing one skipped tick rather than failing this one.
    await (
      redis.eval as unknown as (script: string, numKeys: number, key: string, arg: string) => Promise<unknown>
    )(RELEASE_SCRIPT, 1, TICK_LOCK_KEY, token).catch(() => undefined)
  }
}

/**
 * Production entry point. In inline mode (dev/CI) there is no Redis and only
 * one caller exists, so this is a pass-through — behavior there is unchanged.
 */
export async function withTickLock<T>(fn: () => Promise<T>): Promise<T | { skipped: 'locked' }> {
  if (inlineExecution) return fn()
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  return runWithLock(getRedisConnection() as LockRedis, token, fn)
}

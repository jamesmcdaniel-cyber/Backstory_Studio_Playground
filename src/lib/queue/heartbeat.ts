import { getRedisConnection } from '@/lib/queue/config'

/**
 * Worker liveness heartbeat, written to the SAME Redis the producer enqueues
 * to. The 2026-08-04 outage class — EXECUTION_MODE=queue with no consumer (or
 * a consumer on a different Redis instance) — accepted every run into
 * `waiting` where it hung at "Thinking…" forever. The heartbeat makes that
 * state fail fast at dispatch time: if no worker has written a fresh
 * heartbeat, the run is rejected with an explicit error instead of stranded.
 */

export const WORKER_HEARTBEAT_KEY = 'worker:heartbeat'
/** How often the worker runtime rewrites the heartbeat. */
export const WORKER_HEARTBEAT_INTERVAL_MS = 30_000
/**
 * How old a heartbeat may be before dispatch treats the backend as offline.
 * Four missed intervals — a worker mid-deploy (60s health grace in
 * fly.worker.toml) does not trip the gate; a dead fleet does.
 */
export const WORKER_HEARTBEAT_STALE_MS = 2 * 60_000

export const EXECUTION_BACKEND_OFFLINE_MESSAGE =
  'Execution backend is offline — no worker has reported a heartbeat recently, so the run was not started. Check the worker fleet (fly logs) and /api/health.'

/** Pure staleness verdict over the raw Redis value. */
export function isHeartbeatFresh(
  raw: string | null,
  now: number,
  staleMs: number = WORKER_HEARTBEAT_STALE_MS,
): boolean {
  if (!raw) return false
  const writtenAt = Number(raw)
  if (!Number.isFinite(writtenAt)) return false
  // Future timestamps (clock skew between writer and reader) count as fresh.
  return now - writtenAt <= staleMs
}

/**
 * Worker-side: record liveness. TTL is a backstop so a decommissioned fleet's
 * last heartbeat ages out of Redis entirely rather than lingering as a stale
 * key forever.
 */
export async function writeWorkerHeartbeat(now: number = Date.now()): Promise<void> {
  await getRedisConnection().set(WORKER_HEARTBEAT_KEY, String(now), 'PX', WORKER_HEARTBEAT_STALE_MS * 10)
}

/** Read the raw heartbeat value, bounded so a hung Redis cannot hang dispatch. */
async function readHeartbeat(timeoutMs = 3_000): Promise<string | null> {
  return Promise.race([
    getRedisConnection().get(WORKER_HEARTBEAT_KEY),
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('heartbeat read timed out')), timeoutMs)
      if (typeof timer === 'object') timer.unref?.()
    }),
  ])
}

/** Age of the current heartbeat in ms, or null when absent/unreadable. */
export async function workerHeartbeatAgeMs(now: number = Date.now()): Promise<number | null> {
  try {
    const raw = await readHeartbeat()
    if (!raw || !Number.isFinite(Number(raw))) return null
    return Math.max(0, now - Number(raw))
  } catch {
    return null
  }
}

/**
 * Producer-side gate: throw EXECUTION_BACKEND_OFFLINE_MESSAGE unless a worker
 * heartbeat is fresh. An unreadable Redis counts as offline — the enqueue
 * would strand the job just the same.
 */
export async function assertQueueConsumerAlive(now: number = Date.now()): Promise<void> {
  let raw: string | null = null
  try {
    raw = await readHeartbeat()
  } catch {
    throw new Error(EXECUTION_BACKEND_OFFLINE_MESSAGE)
  }
  if (!isHeartbeatFresh(raw, now)) throw new Error(EXECUTION_BACKEND_OFFLINE_MESSAGE)
}

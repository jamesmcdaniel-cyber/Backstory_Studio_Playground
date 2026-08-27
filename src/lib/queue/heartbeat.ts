import { Queue } from 'bullmq'
import { getRedisConnection, QUEUE_NAMES } from '@/lib/queue/config'

/**
 * Worker liveness heartbeat, written to the SAME Redis the producer enqueues
 * to. The 2026-08-04 outage class — EXECUTION_MODE=queue with no consumer (or
 * a consumer on a different Redis instance) — accepted every run into
 * `waiting` where it hung at "Thinking…" forever. The heartbeat makes that
 * state fail fast at dispatch time: if no worker has written a fresh
 * heartbeat, the run is rejected with an explicit error instead of stranded.
 */

export const WORKER_HEARTBEAT_KEY = 'worker:heartbeat'
export const workerQueueHeartbeatKey = (queue: string) => `${WORKER_HEARTBEAT_KEY}:queue:${queue}`
/** How often the worker runtime rewrites the heartbeat. 60s (not lower):
 * Upstash bills per command, and this write runs 24/7. */
export const WORKER_HEARTBEAT_INTERVAL_MS = 60_000
/**
 * How old a heartbeat may be before dispatch treats the backend as offline.
 * Three missed intervals — a worker mid-deploy (60s health grace in
 * fly.worker.toml) does not trip the gate; a dead fleet does. The gate also
 * falls back to registered-consumer detection, so this latency only affects
 * how fast a TRULY dead fleet is called out.
 */
export const WORKER_HEARTBEAT_STALE_MS = 3 * 60_000

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
export async function writeWorkerHeartbeat(now: number = Date.now(), queues: readonly string[] = []): Promise<void> {
  const redis = getRedisConnection()
  const value = String(now)
  const ttl = WORKER_HEARTBEAT_STALE_MS * 10
  await Promise.all([
    redis.set(WORKER_HEARTBEAT_KEY, value, 'PX', ttl),
    ...queues.map((queue) => redis.set(workerQueueHeartbeatKey(queue), value, 'PX', ttl)),
  ])
}

/** Read the raw heartbeat value, bounded so a hung Redis cannot hang dispatch. */
async function readHeartbeat(timeoutMs = 3_000, key = WORKER_HEARTBEAT_KEY): Promise<string | null> {
  return Promise.race([
    getRedisConnection().get(key),
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('heartbeat read timed out')), timeoutMs)
      if (typeof timer === 'object') timer.unref?.()
    }),
  ])
}

/** Per-queue ages prove WHICH queues a live process consumes. A single global
 * heartbeat cannot detect a missing batch pool while interactive workers live. */
export async function workerQueueHeartbeatAges(
  queues: readonly string[],
  now: number = Date.now(),
): Promise<Record<string, number | null>> {
  try {
    const values = await Promise.race([
      getRedisConnection().mget(...queues.map(workerQueueHeartbeatKey)),
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('queue heartbeat read timed out')), 3_000)
        if (typeof timer === 'object') timer.unref?.()
      }),
    ])
    return Object.fromEntries(queues.map((queue, index) => {
      const writtenAt = Number(values[index])
      return [queue, Number.isFinite(writtenAt) && values[index] ? Math.max(0, now - writtenAt) : null]
    }))
  } catch {
    return Object.fromEntries(queues.map((queue) => [queue, null]))
  }
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
 * Pure liveness decision: a fresh heartbeat is sufficient; without one, live
 * registered BullMQ consumers (the authoritative-but-costlier signal) also
 * count — this keeps dispatch working across a worker image that predates the
 * heartbeat (rollout ordering, DR restores). `null` = probe unreadable →
 * fail closed: that is exactly the state where an enqueued job strands.
 */
export function consumerAliveVerdict(heartbeatFresh: boolean, registeredWorkers: number | null): boolean {
  if (heartbeatFresh) return true
  return registeredWorkers !== null && registeredWorkers > 0
}

// Lazy singleton: a Queue handle holds a Redis connection, and this is only
// needed on the fallback path (no fresh heartbeat).
let flowQueueHandle: Queue | null = null

async function registeredFlowWorkers(timeoutMs = 5_000): Promise<number | null> {
  try {
    flowQueueHandle ??= new Queue(QUEUE_NAMES.FLOW_EXECUTION, { connection: getRedisConnection() })
    const workers = await Promise.race([
      flowQueueHandle.getWorkers(),
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('worker probe timed out')), timeoutMs)
        if (typeof timer === 'object') timer.unref?.()
      }),
    ])
    return workers.length
  } catch {
    return null
  }
}

/**
 * Liveness resolution with injectable probes (tested directly): a fresh
 * heartbeat is sufficient; a FAILED heartbeat read means "unknown", not
 * "dead" — a cold serverless instance whose first Redis command times out
 * must still consult the registered-workers signal before declaring the
 * backend offline. Only both-signals-negative is offline.
 */
export async function resolveConsumerAlive(
  deps: { readHeartbeat: () => Promise<string | null>; registeredWorkers: () => Promise<number | null> },
  now: number,
): Promise<boolean> {
  let raw: string | null = null
  try {
    raw = await deps.readHeartbeat()
  } catch {
    raw = null
  }
  const fresh = isHeartbeatFresh(raw, now)
  if (fresh) return true
  let workers: number | null = null
  try {
    workers = await deps.registeredWorkers()
  } catch {
    workers = null
  }
  return consumerAliveVerdict(false, workers)
}

/**
 * Producer-side gate: throw EXECUTION_BACKEND_OFFLINE_MESSAGE unless the
 * consumer side is provably alive (see resolveConsumerAlive).
 */
export async function assertQueueConsumerAlive(now: number = Date.now()): Promise<void> {
  const alive = await resolveConsumerAlive(
    {
      // Per-queue proof first. The global fallback preserves availability
      // during rolling deploys from worker images predating queue heartbeats.
      readHeartbeat: async () =>
        (await readHeartbeat(3_000, workerQueueHeartbeatKey(QUEUE_NAMES.FLOW_EXECUTION))) ?? readHeartbeat(),
      registeredWorkers: () => registeredFlowWorkers(),
    },
    now,
  )
  if (!alive) throw new Error(EXECUTION_BACKEND_OFFLINE_MESSAGE)
}

import { Queue } from 'bullmq'
import { QUEUE_NAMES, workersEnabled, getRedisConnection } from '@/lib/queue/config'
import { EXECUTION_MODE } from '@/lib/queue/execution-mode'

/**
 * Health probe for the queue plane's CONSUMER side.
 *
 * /api/health already proves Redis is reachable — but reachable is not
 * consumed. When EXECUTION_MODE=queue and the worker fleet is down (or, the
 * documented render.yaml trap, listening on a DIFFERENT Redis than the one the
 * web app enqueues to), every run is accepted, lands in `waiting`, and hangs
 * forever with the app reporting healthy the whole time. That exact outage
 * shipped on 2026-08-04: runs stuck at "No steps recorded", zero workers
 * registered on any queue. This probe makes that state a 503 instead of a
 * silence.
 */

/** The queues a dead consumer strands user-visible work on. */
const CRITICAL_QUEUES = [
  QUEUE_NAMES.AGENT_EXECUTION,
  QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION,
  QUEUE_NAMES.FLOW_EXECUTION,
] as const

export interface QueueConsumerReport {
  queue: string
  /** BullMQ workers currently registered on this queue (CLIENT LIST). */
  workers: number
  waiting: number
  active: number
}

export interface QueueConsumerCheck {
  /** false = inline mode / build phase — the queue plane is not in play. */
  configured: boolean
  ok: boolean
  /** Queues that have jobs waiting AND nobody consuming — live user impact. */
  stranded: string[]
  reports?: QueueConsumerReport[]
  error?: string
}

/**
 * Pure verdict over the per-queue reports: every critical queue must have at
 * least one registered consumer. `stranded` narrows to the acute case — jobs
 * already waiting with nobody to take them. Zero consumers on an EMPTY queue
 * still fails the verdict: the next run enqueued there would hang, and health
 * should say so before a user finds out.
 */
export function consumerVerdict(reports: QueueConsumerReport[]): { ok: boolean; stranded: string[] } {
  if (reports.length === 0) return { ok: false, stranded: [] }
  return {
    ok: reports.every((r) => r.workers > 0),
    stranded: reports.filter((r) => r.workers === 0 && r.waiting > 0).map((r) => r.queue),
  }
}

// One Queue handle per name for the process lifetime — the health route is
// polled, and BullMQ Queue instances hold a Redis connection each.
const handles = new Map<string, Queue>()
function queueHandle(name: string): Queue {
  let q = handles.get(name)
  if (!q) {
    q = new Queue(name, { connection: getRedisConnection() })
    handles.set(name, q)
  }
  return q
}

const PROBE_TIMEOUT_MS = 3_000

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('queue probe timed out')), PROBE_TIMEOUT_MS)
      // Don't hold the event loop open for a probe that already settled.
      if (typeof timer === 'object') timer.unref?.()
    }),
  ])
}

/**
 * Read consumer + backlog state for every critical queue. Read-only. In inline
 * mode (or with BullMQ disabled) the queue plane is not in play and the check
 * reports configured:false, which the health route treats as healthy.
 */
export async function probeQueueConsumers(): Promise<QueueConsumerCheck> {
  if (EXECUTION_MODE !== 'queue' || !workersEnabled || !process.env.REDIS_URL) {
    return { configured: false, ok: true, stranded: [] }
  }
  try {
    const reports = await withTimeout(
      Promise.all(
        CRITICAL_QUEUES.map(async (name): Promise<QueueConsumerReport> => {
          const q = queueHandle(name)
          const [workers, counts] = await Promise.all([q.getWorkers(), q.getJobCounts('waiting', 'active')])
          return { queue: name, workers: workers.length, waiting: counts.waiting ?? 0, active: counts.active ?? 0 }
        }),
      ),
    )
    return { configured: true, ...consumerVerdict(reports), reports }
  } catch (error) {
    // An unreadable queue plane is a failed check, not an unknown — this is
    // exactly the state where runs hang invisibly.
    return {
      configured: true,
      ok: false,
      stranded: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

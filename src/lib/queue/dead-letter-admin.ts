/**
 * Operator read/repair surface over the dead-letter queues.
 *
 * Dead-lettered jobs are durable but, until this module existed, only
 * *countable*: `/api/health` reported `deadLetters.total` and the only way to
 * see a payload was `redis-cli` by hand against production Upstash. That is a
 * bad place to be mid-incident, so the same operations are exposed twice —
 * `scripts/queue-dlq.ts` for a terminal and `/api/admin/queue/dead-letters`
 * for anything else — over this one implementation.
 *
 * Both callers are operator-only. The CLI needs REDIS_URL (i.e. someone who
 * already holds production secrets); the route is `platform.administer` +
 * `internalOnly`.
 */

import type { Queue } from 'bullmq'
import { createQueue, QUEUE_NAMES } from './config'

/**
 * The three dead-letter queues, each mapped to the ORIGINAL queues a record on
 * it is allowed to be replayed into.
 *
 * The replay target is read from the dead-lettered record's `queue` field,
 * which is job data — i.e. it came out of Redis. Constraining it to this table
 * means a tampered record can only ever re-enqueue onto a queue that dead
 * letter legitimately serves, never an arbitrary queue name of the writer's
 * choosing.
 */
const DLQ_TOPOLOGY: Record<string, readonly string[]> = {
  [QUEUE_NAMES.DEAD_LETTER]: [QUEUE_NAMES.AGENT_EXECUTION, QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION],
  [QUEUE_NAMES.FLOW_DEAD_LETTER]: [QUEUE_NAMES.FLOW_EXECUTION],
  [QUEUE_NAMES.TEMPLATE_GENERATION_DEAD_LETTER]: [QUEUE_NAMES.TEMPLATE_GENERATION],
}

export const DEAD_LETTER_QUEUES = Object.keys(DLQ_TOPOLOGY)

/** Job states a parked DLQ record can be in. Nothing consumes these queues, so
 * in practice everything is `waiting` — the rest are listed so a record can
 * never hide from an operator because of an unexpected state. */
const DLQ_STATES = ['waiting', 'delayed', 'active', 'completed', 'failed', 'paused'] as const

/** Fallback job name for a replay of a record written before `jobName` was recorded. */
const REPLAY_FALLBACK_NAME: Record<string, string> = {
  [QUEUE_NAMES.AGENT_EXECUTION]: 'execute-agent',
  [QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION]: 'execute-scheduled-agent',
  [QUEUE_NAMES.FLOW_EXECUTION]: 'execute-flow',
  [QUEUE_NAMES.TEMPLATE_GENERATION]: 'generate-templates',
}

/** The shape every dead-letter module writes (see dead-letter.ts and siblings). */
export interface DeadLetterRecord {
  queue?: string
  jobId?: string
  jobName?: string
  executionId?: string
  flowRunId?: string
  organizationId?: string
  data?: unknown
  error?: string
}

export interface DeadLetterSummary {
  /** `<dlq-name>:<job-id>` — the handle every mutating operation takes. */
  id: string
  dlq: string
  /** The queue the job originally failed on (its replay target). */
  queue: string | null
  jobName: string | null
  executionId: string | null
  flowRunId: string | null
  organizationId: string | null
  failedReason: string | null
  timestamps: { enqueuedAt: string | null; processedAt: string | null; finishedAt: string | null }
  /** One-line shape of the payload — enough to recognise a job without dumping it. */
  payloadSummary: string
  replayable: boolean
}

export interface DeadLetterDetail extends DeadLetterSummary {
  /** The full original job payload. Operator-only: it can contain run inputs. */
  payload: unknown
  attemptsMade: number
}

/** Injectable seam — production uses createQueue; tests stub it (no Redis). */
export interface DeadLetterAdminDeps {
  createQueue: typeof createQueue
}

/** Constructed once (not per call) so the handle cache below is shared. */
const DEFAULT_DEPS: DeadLetterAdminDeps = { createQueue }
const defaultDeps = (): DeadLetterAdminDeps => DEFAULT_DEPS

/**
 * One handle per queue name for the lifetime of a deps object — each BullMQ
 * Queue holds its own Redis client, and both callers touch several queues per
 * invocation. Keyed by deps rather than globally so a test's stub queues are
 * never served to production code, or to the next test.
 */
const handleCache = new WeakMap<DeadLetterAdminDeps, Map<string, Queue>>()

function handle(name: string, deps: DeadLetterAdminDeps): Queue {
  let handles = handleCache.get(deps)
  if (!handles) {
    handles = new Map()
    handleCache.set(deps, handles)
  }
  let queue = handles.get(name)
  if (!queue) {
    queue = deps.createQueue(name)
    handles.set(name, queue)
  }
  return queue
}

/** Release every cached handle. The CLI calls this so the process can exit. */
export async function closeDeadLetterHandles(deps: DeadLetterAdminDeps = defaultDeps()): Promise<void> {
  const handles = handleCache.get(deps)
  if (!handles) return
  const open = [...handles.values()]
  handles.clear()
  await Promise.all(open.map((queue) => queue.close().catch(() => {})))
}

export class DeadLetterOperationError extends Error {
  constructor(message: string, readonly code: string, readonly status = 400) {
    super(message)
    this.name = 'DeadLetterOperationError'
  }
}

/** `agent-dead-letter:41` → its parts. Queue names never contain `:`. */
export function parseDeadLetterId(id: string): { dlq: string; jobId: string } {
  const separator = id.indexOf(':')
  const dlq = separator === -1 ? '' : id.slice(0, separator)
  const jobId = separator === -1 ? '' : id.slice(separator + 1)
  if (!jobId || !(dlq in DLQ_TOPOLOGY)) {
    throw new DeadLetterOperationError(
      `Not a dead-letter id: ${id}. Expected <${DEAD_LETTER_QUEUES.join('|')}>:<jobId>.`,
      'INVALID_DEAD_LETTER_ID',
      400,
    )
  }
  return { dlq, jobId }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

/** A recognisable one-liner, never the whole payload (which can be large). */
export function summarizePayload(payload: unknown): string {
  if (payload === null || payload === undefined) return 'none'
  if (typeof payload !== 'object') return String(payload).slice(0, 120)
  if (Array.isArray(payload)) return `array(${payload.length})`
  const keys = Object.keys(payload as Record<string, unknown>)
  return keys.length ? `{ ${keys.slice(0, 12).join(', ')}${keys.length > 12 ? ', …' : ''} }` : '{}'
}

/** The queue a record may be replayed onto, or null when it may not be. */
export function replayTarget(dlq: string, record: DeadLetterRecord): string | null {
  const allowed = DLQ_TOPOLOGY[dlq]
  if (!allowed) return null
  const target = asString(record.queue)
  return target && allowed.includes(target) ? target : null
}

/** Minimal structural view of a BullMQ job — keeps the tests free of bullmq. */
interface JobLike {
  id?: string | null
  name?: string
  data?: unknown
  attemptsMade?: number
  failedReason?: string | null
  timestamp?: number | null
  processedOn?: number | null
  finishedOn?: number | null
  remove: () => Promise<unknown>
}

function iso(value: number | null | undefined): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : null
}

function toSummary(dlq: string, job: JobLike): DeadLetterSummary {
  const record = (job.data ?? {}) as DeadLetterRecord
  const target = replayTarget(dlq, record)
  return {
    id: `${dlq}:${job.id ?? ''}`,
    dlq,
    queue: asString(record.queue),
    jobName: asString(record.jobName),
    executionId: asString(record.executionId),
    flowRunId: asString(record.flowRunId),
    organizationId: asString(record.organizationId),
    // The DLQ record's own `error` is the failure that put it here. BullMQ's
    // failedReason would only describe a failure of the DLQ write itself.
    failedReason: asString(record.error),
    timestamps: {
      enqueuedAt: iso(job.timestamp),
      processedAt: iso(job.processedOn),
      finishedAt: iso(job.finishedOn),
    },
    payloadSummary: summarizePayload(record.data),
    replayable: target !== null,
  }
}

export interface ListOptions {
  /** Restrict to one dead-letter queue. Defaults to all three. */
  dlq?: string
  /** Max records per queue (newest first). */
  limit?: number
}

export async function listDeadLetters(
  options: ListOptions = {},
  deps: DeadLetterAdminDeps = defaultDeps(),
): Promise<DeadLetterSummary[]> {
  const limit = Math.min(200, Math.max(1, options.limit ?? 50))
  const queues = options.dlq ? [options.dlq] : DEAD_LETTER_QUEUES
  for (const name of queues) {
    if (!(name in DLQ_TOPOLOGY)) {
      throw new DeadLetterOperationError(`Unknown dead-letter queue: ${name}`, 'UNKNOWN_DEAD_LETTER_QUEUE', 400)
    }
  }

  const perQueue = await Promise.all(
    queues.map(async (name) => {
      const jobs = (await handle(name, deps).getJobs([...DLQ_STATES], 0, limit - 1, false)) as unknown as JobLike[]
      return jobs.filter(Boolean).map((job) => toSummary(name, job))
    }),
  )
  return perQueue
    .flat()
    .sort((a, b) => (b.timestamps.enqueuedAt ?? '').localeCompare(a.timestamps.enqueuedAt ?? ''))
}

export async function countDeadLetters(
  deps: DeadLetterAdminDeps = defaultDeps(),
): Promise<{ total: number; queues: { queue: string; waiting: number }[] }> {
  const queues = await Promise.all(
    DEAD_LETTER_QUEUES.map(async (name) => {
      const counts = await handle(name, deps).getJobCounts('waiting')
      return { queue: name, waiting: counts.waiting ?? 0 }
    }),
  )
  return { total: queues.reduce((sum, q) => sum + q.waiting, 0), queues }
}

async function requireJob(id: string, deps: DeadLetterAdminDeps): Promise<{ dlq: string; job: JobLike }> {
  const { dlq, jobId } = parseDeadLetterId(id)
  const job = (await handle(dlq, deps).getJob(jobId)) as unknown as JobLike | undefined
  if (!job) {
    throw new DeadLetterOperationError(`No dead-letter job ${id}`, 'DEAD_LETTER_NOT_FOUND', 404)
  }
  return { dlq, job }
}

export async function showDeadLetter(
  id: string,
  deps: DeadLetterAdminDeps = defaultDeps(),
): Promise<DeadLetterDetail> {
  const { dlq, job } = await requireJob(id, deps)
  const record = (job.data ?? {}) as DeadLetterRecord
  return { ...toSummary(dlq, job), payload: record.data, attemptsMade: job.attemptsMade ?? 0 }
}

export interface ReplayResult {
  id: string
  queue: string
  jobName: string
  newJobId: string | null
}

/**
 * Re-enqueue a dead-lettered job onto its ORIGINAL queue with a fresh attempt
 * budget, then remove the DLQ record.
 *
 * Deliberately in that order: a replay that enqueues and then fails to remove
 * leaves a stale DLQ record (visible, re-droppable), whereas removing first and
 * failing to enqueue would lose the job outright.
 *
 * Replaying is genuinely destructive — an agent/flow job has external side
 * effects, and although the runtime replays already-completed tool calls from
 * the step ledger rather than re-firing them, that only holds when the failure
 * is downstream of a checkpoint. Both callers put this behind an explicit
 * confirmation.
 */
export async function replayDeadLetter(
  id: string,
  deps: DeadLetterAdminDeps = defaultDeps(),
): Promise<ReplayResult> {
  const { dlq, job } = await requireJob(id, deps)
  const record = (job.data ?? {}) as DeadLetterRecord
  const target = replayTarget(dlq, record)
  if (!target) {
    throw new DeadLetterOperationError(
      `Record ${id} names no replayable origin queue (queue=${String(record.queue)}). Re-run it from the app instead.`,
      'DEAD_LETTER_NOT_REPLAYABLE',
      409,
    )
  }

  const jobName = asString(record.jobName) ?? REPLAY_FALLBACK_NAME[target] ?? 'replay'
  const enqueued = await handle(target, deps).add(jobName, record.data, {
    // A replay is an operator saying "run this again", so it gets the standard
    // attempt budget back rather than inheriting the exhausted one.
    attempts: 2,
    backoff: { type: 'fixed', delay: 2_000 },
  })
  await job.remove()
  return { id, queue: target, jobName, newJobId: enqueued?.id ?? null }
}

export async function dropDeadLetter(
  id: string,
  deps: DeadLetterAdminDeps = defaultDeps(),
): Promise<{ id: string }> {
  const { job } = await requireJob(id, deps)
  await job.remove()
  return { id }
}

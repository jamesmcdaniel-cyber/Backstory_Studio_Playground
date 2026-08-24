import 'dotenv/config'
import Fastify, { type FastifyInstance } from 'fastify'
import { Worker, type Processor, type WorkerOptions } from 'bullmq'
import { executeAgentJob } from '@/features/agents/execute-agent'
import { executeFlowJob } from '@/features/flows/execute-flow'
import { getRedisConnection, QUEUE_NAMES, workerConfig } from '@/lib/queue/config'
import { writeWorkerHeartbeat, WORKER_HEARTBEAT_INTERVAL_MS } from '@/lib/queue/heartbeat'
import { deadLetterFromJob } from '@/lib/queue/dead-letter'
import { deadLetterFromFlowJob } from '@/lib/queue/flow-dead-letter'
import { deadLetterFromTemplateGenerationJob } from '@/lib/queue/template-generation-dead-letter'
import { executeTemplateGenerationJob } from '@/lib/templates/generation-queue'
import { runBench } from '@/lib/eval/bench'
import { runActivityBackfill } from '@/lib/activity/backfill'
import { registerAgentSchedules } from '@/lib/workers/agent-schedule-registrar'
import { runDispatchTick } from '@/lib/scheduling/dispatch-tick'
import { assertWorkerEnv } from '@/lib/workers/assert-env'
import { initSentry, captureError, flushErrorReporting } from '@/lib/observability/sentry'
import { processOutboxBatch } from '@/lib/outbox'
import { isCustomerEdition } from '@/lib/edition'

/**
 * How often the worker drives the scheduling tick. 60s, against the Vercel
 * cron's 15 minutes — this is what makes the every15min/every30min cadences
 * real rather than aspirational.
 */
const DISPATCH_TICK_INTERVAL_MS = 60_000

/**
 * One queue this process consumes: which queue, what runs a job, and where a
 * terminal failure is recorded. `handler` is typed as the generic BullMQ
 * Processor so the array (mixing the agent- and flow-job handler signatures)
 * unifies to one element type — each queue is still wired to its own
 * correctly-typed handler at runtime.
 */
export interface WorkerSpec {
  queue: string
  handler: Processor<any, any, string>
  onFailed: (job: any, error: Error) => void
  /**
   * Which machine pool consumes this queue. See `resolveWorkerPool`.
   *
   * `interactive` is work somebody is waiting on: a person clicked Run, or a
   * schedule fired and its output is expected soon. `batch` is operator work
   * measured in minutes — a template generation sweep, a cross-model bench, an
   * activity backfill over a paginated provider API.
   */
  pool: WorkerPool
  /**
   * Per-queue concurrency override.
   *
   * Batch jobs are long and memory-hungry (a bench holds fixtures × candidates
   * in flight; a backfill holds a provider page). Running them at the same
   * concurrency as short agent turns is how a 1 GB machine reaches its memory
   * ceiling, and on a shared pool it takes the interactive queues down with it.
   */
  concurrency?: number
}

export type WorkerPool = 'interactive' | 'batch' | 'all'

/**
 * Which queues this process consumes, from WORKER_POOL.
 *
 * ── Why the split exists ──────────────────────────────────────────────────
 * One pool consumed all six queues, so its ~20 in-flight slots were shared
 * between "a person is waiting for this" and "an operator kicked off a bench".
 * A single backfill over a slow provider API could hold slots for minutes while
 * interactive runs queued behind it, and no amount of scaling fixes that — it
 * just buys more slots for the same contention.
 *
 * Splitting also lets the two halves scale on different signals. Interactive
 * depth should track user activity and wants headroom; batch depth is bursty,
 * operator-driven, and can be served by one small machine that is idle most of
 * the day.
 *
 * `all` is the default deliberately: it is what a single `fly deploy`, a
 * docker-compose, and every existing deployment already do, so nothing changes
 * until someone opts into the split by setting WORKER_POOL on each app.
 */
export function resolveWorkerPool(raw = process.env.WORKER_POOL): WorkerPool {
  if (raw === 'interactive' || raw === 'batch' || raw === 'all') return raw
  if (raw) {
    // Never silently: a typo here would produce a fleet consuming the wrong
    // queues, which presents as "runs are stuck" with a perfectly healthy
    // worker reporting a heartbeat.
    console.warn(`WORKER_POOL is invalid (${JSON.stringify(raw)}) — consuming ALL queues. Use "interactive", "batch" or "all".`)
  }
  return 'all'
}

/** Batch concurrency, well below the interactive default — see WorkerSpec.concurrency. */
const BATCH_CONCURRENCY = Math.max(1, Number(process.env.BATCH_WORKER_CONCURRENCY) || 2)

/**
 * The consumer topology, as a pure function of the edition.
 *
 * Extracted from the class (it used to be a field initializer) purely so the
 * registration decision is assertable without a Redis connection — which queues
 * this process consumes, and that each is paired with the dead-letter target
 * that owns the right table, is exactly the wiring an outage turns on.
 */
/**
 * One bench run per job. `models` is the panel's chip selection — already
 * validated against the benchable roster by the enqueueing route, and filtered
 * again against configured endpoints inside runBench, so a stale payload can
 * never bench an endpoint this worker cannot reach. An empty payload keeps the
 * environment defaults (BENCH_MODELS), the same source the CLI reads, so the
 * button and the shell measure the same thing.
 */
async function executeModelBenchJob(job: { id?: string; data?: { models?: string[]; organizationId?: string } }) {
  const summary = await runBench({
    models: Array.isArray(job.data?.models) ? job.data.models : undefined,
    organizationId: job.data?.organizationId,
    log: (line) => console.log(`[model-bench ${job.id ?? ''}] ${line}`),
  })
  if (summary.errors > 0) {
    throw new Error(`bench finished with ${summary.errors} errored fixture(s); ${summary.recorded} recorded`)
  }
  return summary
}

/**
 * One backfill job per `(organizationId, source, connectionId)` cursor — see
 * src/lib/activity/backfill.ts. Additive-only and idempotent (cursor only
 * ever advances past durably-persisted rows), so a thrown error here needs no
 * dead-letter target: the cursor is exactly where the last successful page
 * left it, and re-triggering the same admin action resumes from there.
 */
async function executeActivityBackfillJob(job: { id?: string; data?: { organizationId?: string; source?: string; connectionId?: string } }) {
  const { organizationId, source, connectionId } = job.data ?? {}
  if (!organizationId || !source || !connectionId) {
    throw new Error(`activity-backfill job ${job.id ?? '?'} is missing organizationId/source/connectionId`)
  }
  const result = await runActivityBackfill(organizationId, source, connectionId)
  console.log(`[activity-backfill ${job.id ?? ''}] ${JSON.stringify(result)}`)
  if (result.status === 'no-connection') {
    throw new Error(`activity-backfill: no connected NangoConnection ${connectionId} for org ${organizationId}`)
  }
  return result
}

export function buildWorkerSpecs(
  customerEdition = isCustomerEdition(),
  pool: WorkerPool = resolveWorkerPool(),
): WorkerSpec[] {
  const all: WorkerSpec[] = [
    { queue: QUEUE_NAMES.AGENT_EXECUTION, handler: executeAgentJob, onFailed: deadLetterFromJob(QUEUE_NAMES.AGENT_EXECUTION), pool: 'interactive' },
    { queue: QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION, handler: executeAgentJob, onFailed: deadLetterFromJob(QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION), pool: 'interactive' },
    // Flow execution: same worker pool, its own queue and dead-letter target
    // (flowRun rows, not agentExecution rows) — see flow-dead-letter.ts.
    { queue: QUEUE_NAMES.FLOW_EXECUTION, handler: executeFlowJob, onFailed: deadLetterFromFlowJob(QUEUE_NAMES.FLOW_EXECUTION), pool: 'interactive' },
    // Gated AI template generation: its own queue + dead-letter target. The
    // dead-letter terminalizes nothing (generation is additive) — see
    // template-generation-dead-letter.ts. Absent entirely in the customer
    // edition, which never enqueues this job.
    ...(customerEdition
      ? []
      : [{
          queue: QUEUE_NAMES.TEMPLATE_GENERATION,
          handler: executeTemplateGenerationJob as Processor<any, any, string>,
          onFailed: deadLetterFromTemplateGenerationJob(QUEUE_NAMES.TEMPLATE_GENERATION),
          pool: 'batch' as const,
          concurrency: BATCH_CONCURRENCY,
        },
        // Operator bench (internal edition only — the customer edition has no
        // Models console to trigger it). Additive-only, so no dead-letter
        // target: results persisted before a failure survive it, and the
        // failure itself is a log line, not a stranded run row.
        {
          queue: QUEUE_NAMES.MODEL_BENCH,
          handler: executeModelBenchJob as Processor<any, any, string>,
          onFailed: (job: any, error: Error) =>
            console.error(`model-bench job ${job?.id ?? '?'} failed: ${error.message}`),
          pool: 'batch' as const,
          concurrency: BATCH_CONCURRENCY,
        },
        // Operator-triggered activity backfill (internal edition only, same as
        // bench/template generation above — the customer edition has no
        // Activity admin surface to trigger it from).
        {
          queue: QUEUE_NAMES.ACTIVITY_BACKFILL,
          handler: executeActivityBackfillJob as Processor<any, any, string>,
          onFailed: (job: any, error: Error) =>
            console.error(`activity-backfill job ${job?.id ?? '?'} failed: ${error.message}`),
          pool: 'batch' as const,
          concurrency: BATCH_CONCURRENCY,
        }]),
  ]
  return pool === 'all' ? all : all.filter((spec) => spec.pool === pool)
}

/** The subset of a BullMQ Worker this runtime drives. */
export interface WorkerHandle {
  isRunning: () => boolean
  on: (event: 'failed', listener: (job: any, error: Error) => void) => unknown
  close: () => Promise<unknown>
}

/**
 * Injectable seams. Production uses the defaults; tests substitute the Redis
 * and process edges so the wiring above can be asserted without booting real
 * workers (same pattern as dead-letter.ts's DeadLetterDeps).
 */
export interface WorkerRuntimeDeps {
  specs: WorkerSpec[]
  createServer: () => FastifyInstance
  createWorker: (queue: string, handler: Processor<any, any, string>, options: WorkerOptions) => WorkerHandle
  /** Resolves the shared Redis client — used for the health check's PING. */
  connection: () => { ping: () => Promise<string> }
  /** Signal registration, so a test can drive shutdown without touching process. */
  onSignal: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void
  exit: (code: number) => void
}

function defaultDeps(): WorkerRuntimeDeps {
  return {
    specs: buildWorkerSpecs(),
    createServer: () => Fastify({ logger: true }),
    createWorker: (queue, handler, options) => new Worker(queue, handler, options) as unknown as WorkerHandle,
    connection: () => getRedisConnection(),
    onSignal: (signal, handler) => { process.on(signal, handler) },
    exit: (code) => process.exit(code),
  }
}

class WorkerRuntime {
  private deps: WorkerRuntimeDeps
  private server: FastifyInstance
  private scheduleTimer?: NodeJS.Timeout
  private outboxTimer?: NodeJS.Timeout
  private heartbeatTimer?: NodeJS.Timeout
  private dispatchTimer?: NodeJS.Timeout
  private workerSpecs: WorkerSpec[]
  private workers: WorkerHandle[]

  constructor(deps: Partial<WorkerRuntimeDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps }
    this.server = this.deps.createServer()
    this.workerSpecs = this.deps.specs
    this.workers = this.workerSpecs.map((spec) =>
      this.deps.createWorker(spec.queue, spec.handler, {
        ...workerConfig,
        // Per-queue override where one is declared, so a long batch job cannot
        // be run at the interactive queues' concurrency.
        ...(spec.concurrency ? { concurrency: spec.concurrency } : {}),
        connection: this.deps.connection() as never,
      }),
    )

    // Real readiness: reflect that the workers are running AND Redis is
    // reachable. A dead Redis connection means the worker consumes nothing —
    // returning 503 lets Docker's healthcheck/restart policy recycle it instead
    // of leaving a silently-dead worker reporting healthy.
    this.server.get('/health', async (_request, reply) => {
      const running = this.workers.every((worker) => worker.isRunning())
      let redis = false
      try {
        redis = (await this.deps.connection().ping()) === 'PONG'
      } catch {
        redis = false
      }
      const healthy = running && redis
      reply.code(healthy ? 200 : 503)
      return {
        status: healthy ? 'healthy' : 'unhealthy',
        workers: Object.fromEntries(this.workerSpecs.map((spec, index) => [spec.queue, this.workers[index].isRunning()])),
        redis,
        uptime: process.uptime(),
      }
    })
    // Failed jobs are dead-lettered (durable, inspectable) — see buildWorkerSpecs
    // above for the per-queue handler (agent vs. flow target different tables).
    this.workers.forEach((worker, index) => worker.on('failed', this.workerSpecs[index].onFailed))
    this.setupShutdown()
  }

  /** The queues this process consumes. Exposed for boot logging and tests. */
  get queues(): string[] {
    return this.workerSpecs.map((spec) => spec.queue)
  }

  /**
   * Stop every timer, the HTTP server and every worker, flush error reporting,
   * then exit. Public so shutdown is testable without raising a real signal.
   */
  async shutdown(): Promise<void> {
    if (this.scheduleTimer) clearInterval(this.scheduleTimer)
    if (this.outboxTimer) clearInterval(this.outboxTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.dispatchTimer) clearInterval(this.dispatchTimer)
    await this.server.close()
    await Promise.all(this.workers.map((worker) => worker.close()))
    await flushErrorReporting()
    this.deps.exit(0)
  }

  private setupShutdown() {
    const shutdown = () => { void this.shutdown() }
    this.deps.onSignal('SIGINT', shutdown)
    this.deps.onSignal('SIGTERM', shutdown)
  }

  async start(port = 3002) {
    // Fail loud at boot, not at a user's run: fatal env gaps throw here (the
    // process exits via the start() catch below); degraded-capability gaps
    // are warned once where fly logs surfaces them.
    assertWorkerEnv(workerConfig.concurrency, {
      warn: (msg) => this.server.log.warn(msg),
      error: (msg) => this.server.log.error(msg),
    })
    await initSentry('worker')
    // Reports and keeps running — does NOT exit, unlike uncaughtException
    // below. A single unhandled rejection in one BullMQ job must not take
    // down every other in-flight job on this worker; we'd rather report and
    // stay up than let one bad promise kill the process.
    process.on('unhandledRejection', (reason) => {
      captureError(reason, { source: 'worker.unhandledRejection' })
    })
    process.on('uncaughtException', (error) => {
      captureError(error, { source: 'worker.uncaughtException' })
      void flushErrorReporting().finally(() => process.exit(1))
    })
    // Liveness heartbeat: the producer's dispatch gate reads this key before
    // enqueueing. Written FIRST so a freshly-booted worker unblocks dispatch
    // immediately; failures are logged, not fatal — the health check (which
    // pings the same Redis) is what recycles a truly disconnected worker.
    await writeWorkerHeartbeat().catch((error) => this.server.log.error(error, 'Heartbeat write failed'))
    this.heartbeatTimer = setInterval(() => {
      writeWorkerHeartbeat().catch((error) => this.server.log.error(error, 'Heartbeat write failed'))
    }, WORKER_HEARTBEAT_INTERVAL_MS)
    await registerAgentSchedules()
    await processOutboxBatch().catch((error) => this.server.log.error(error, 'Initial outbox delivery failed'))
    this.scheduleTimer = setInterval(() => {
      registerAgentSchedules().catch((error) => this.server.log.error(error, 'Schedule reconciliation failed'))
    }, 60_000)
    this.outboxTimer = setInterval(() => {
      processOutboxBatch().catch((error) => this.server.log.error(error, 'Outbox delivery failed'))
    }, 15_000)
    // Dispatch tick: the worker plane drives scheduling too, at 60s instead of
    // the Vercel cron's 15 minutes. Both planes call the SAME function behind a
    // Redis lock (tick-lock.ts), so running both is safe and either surviving
    // alone keeps schedules firing.
    //
    // Deliberately NOT run at boot the way registerAgentSchedules is: a fleet
    // rolling three machines would fire three ticks seconds apart. The lock
    // makes that harmless but pointless — the first interval is soon enough.
    this.dispatchTimer = setInterval(() => {
      runDispatchTick().catch((error) => this.server.log.error(error, 'Dispatch tick failed'))
    }, DISPATCH_TICK_INTERVAL_MS)
    await this.server.listen({ port, host: '0.0.0.0' })
    // Boot marker: names the consumed queues on one line, so `fly logs` (and
    // the CI worker smoke step) can prove the topology this build registered
    // rather than inferring it from silence.
    this.server.log.info(`worker ready: consuming ${this.queues.join(', ')}`)
  }
}

if (require.main === module) {
  new WorkerRuntime().start(Number(process.env.WORKER_PORT) || 3002).catch(async (error) => {
    console.error(error)
    captureError(error, { source: 'worker.start' })
    await flushErrorReporting()
    process.exit(1)
  })
}

export { WorkerRuntime }

import IORedis from 'ioredis'
import { Queue, type QueueOptions, type WorkerOptions } from 'bullmq'
import { AGENT_RUN_TIMEOUT_MS } from '@/lib/agents/timeouts'

export const QUEUE_NAMES = {
  AGENT_EXECUTION: 'agent-execution',
  SCHEDULED_AGENT_EXECUTION: 'scheduled-agent-execution',
  // Poison jobs land here after their single attempt fails, so a failed run is
  // durably inspectable (and re-runnable by an operator) instead of vanishing.
  // We do NOT auto-retry: agent runs have external side effects.
  DEAD_LETTER: 'agent-dead-letter',
  FLOW_EXECUTION: 'flow-execution',
  FLOW_DEAD_LETTER: 'flow-dead-letter',
  // Gated, org-level AI template generation (sub-project C). Enqueued when an
  // org's 3-integration gate first clears and by a daily debounced cron sweep.
  // A failed job is additive-only (it writes new `open` proposals via one
  // createMany) so its dead-letter has no in-flight run row to terminalize.
  TEMPLATE_GENERATION: 'template-generation',
  TEMPLATE_GENERATION_DEAD_LETTER: 'template-generation-dead-letter',
  // Operator-triggered cross-model bench (Admin → Models → Run bench). Long
  // (fixtures × candidates × judge samples), so it runs on the worker, never
  // in a request. No dead-letter queue: the job is additive-only — each result
  // row is persisted as it lands, so a failed run leaves partial results and a
  // log line, and re-running simply adds a fresh batch.
  MODEL_BENCH: 'model-bench',
  // Cursor-checkpointed activity backfill (Admin → Activity → Backfill; Task 7
  // of the activity-event substrate plan). Internal-edition operator surface,
  // same as MODEL_BENCH/TEMPLATE_GENERATION — no dead-letter queue: every page
  // persists idempotently (createMany/skipDuplicates) and only advances the
  // cursor after persisting, so a failed job leaves the cursor exactly where
  // the last successful page left it and re-triggering resumes cleanly.
  ACTIVITY_BACKFILL: 'activity-backfill',
} as const

const buildPhase = process.env.NEXT_PHASE === 'phase-production-build'
export const workersEnabled = process.env.BULLMQ_DISABLE !== 'true' && !buildPhase

let connection: IORedis | null = null

export function getRedisConnection() {
  if (!workersEnabled) throw new Error('BullMQ is disabled')
  if (!process.env.REDIS_URL) throw new Error('REDIS_URL is required for the worker runtime')
  connection ??= new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
  })
  return connection
}

export const workerConfig = {
  concurrency: Number(process.env.AGENT_WORKER_CONCURRENCY) || 3,
  // Agent runs are long (multi-turn) with external side effects. The lock is
  // held long enough that a live run isn't declared stalled. A retry/stall
  // recovery is now SAFE because runAgentExecution checkpoints the transcript
  // per turn and resumes from the last completed turn (not from the top), and
  // already-completed tool calls are replayed from the step ledger instead of
  // re-fired — so we allow one stall recovery.
  lockDuration: AGENT_RUN_TIMEOUT_MS,
  maxStalledCount: 1,
  // Upstash bills per COMMAND, and an idle BullMQ worker is mostly polling:
  // the blocking dequeue re-issues every `drainDelay` seconds when the queue
  // is empty, and the stalled-job scan runs every `stalledInterval` ms — per
  // queue, 24/7. The defaults (5s / 30s) burned ~2.5M commands/month across
  // four queues, which blew the 500K free-tier cap mid-month and took the
  // whole plane down. 60s / 5min cuts idle burn ~10x; a job enqueued while
  // blocked is still picked up immediately (the block is on the queue key),
  // and stall recovery latency of minutes is fine for runs that live minutes.
  drainDelay: 60,
  stalledInterval: 300_000,
} satisfies Partial<WorkerOptions>

export function createQueue(name: string, overrides: Partial<QueueOptions> = {}) {
  return new Queue(name, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      // One retry: durable resume means a retry continues from the last
      // checkpointed turn and replays completed side effects as no-ops, so a
      // transient failure recovers instead of dead-lettering the whole run.
      attempts: 2,
      backoff: { type: 'fixed', delay: 2_000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    },
    ...overrides,
  })
}

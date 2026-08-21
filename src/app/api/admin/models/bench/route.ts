import { z } from 'zod'
import { createQueue, getRedisConnection, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'
import { inlineExecution } from '@/lib/queue/execution-mode'
import { benchableModels, runBench } from '@/lib/eval/bench'
import { recordAudit } from '@/lib/audit'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

/**
 * "Run bench" — the button behind Admin → Models → Quality.
 *
 * The bench is long (fixtures × candidates × judge samples) and spends real
 * tokens, so in queue mode it is enqueued for the worker, exactly like a run.
 * Inline mode (development, one `next dev`, no Redis) fires it detached in
 * this process instead — the same split every execution path here makes.
 *
 * One at a time: a second click while a bench is queued or running answers
 * `alreadyRunning` rather than stacking a duplicate — each bench is a full
 * candidates × fixtures sweep, so two concurrent ones would double-spend to
 * measure the same thing.
 */

/** True when a model-bench job is already waiting or executing. */
async function benchInFlight(): Promise<boolean> {
  const queue = createQueue(QUEUE_NAMES.MODEL_BENCH)
  const counts = await queue.getJobCounts('waiting', 'active', 'delayed')
  return (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0) > 0
}

// Serializes inline runs the same way benchInFlight serializes queued ones.
let inlineBenchRunning = false

export const POST = withAuthenticatedApi(async (request, auth) => {
  // The panel's chip selection. Optional and defensive: an empty body keeps
  // the environment defaults, and anything not on the benchable roster is
  // refused rather than silently dropped — a typo'd id failing loudly beats a
  // bench that quietly measured fewer models than the operator picked.
  const { models } = z
    .object({ models: z.array(z.string().min(1).max(100)).max(12).optional() })
    .parse(await request.json().catch(() => ({})))
  if (models?.length) {
    const roster = new Set(benchableModels())
    const unknown = models.filter((model) => !roster.has(model))
    if (unknown.length) {
      throw new ApiError(`Not benchable here: ${unknown.join(', ')} — endpoint not configured or unknown model.`, 400, 'UNBENCHABLE_MODEL')
    }
  }

  // Audited before dispatch: pressing the button spends platform tokens across
  // every selected candidate, which is an operator act worth a record even
  // when the run itself later fails.
  await recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.userId,
    action: 'platform.models.bench_started',
    resourceType: 'model_bench',
    detail: { mode: inlineExecution ? 'inline' : 'queue', models: models ?? null },
  })

  if (inlineExecution) {
    if (inlineBenchRunning) return { success: true, alreadyRunning: true }
    inlineBenchRunning = true
    // Detached on purpose: a dev-server request must return, not sit through
    // the whole sweep. Safe only because inline mode is the long-lived dev
    // process, never a serverless function (see execution-mode.ts).
    void runBench({ models, organizationId: auth.organizationId })
      .catch((error) => console.error('inline bench failed:', error instanceof Error ? error.message : error))
      .finally(() => {
        inlineBenchRunning = false
      })
    return { success: true, queued: true, mode: 'inline' }
  }

  if (!workersEnabled) throw new ApiError('The worker runtime is disabled', 503, 'WORKER_DISABLED')
  try {
    // Wake the lazy connection before asking it questions.
    await getRedisConnection().connect().catch(() => undefined)
    if (await benchInFlight()) return { success: true, alreadyRunning: true }
    const queue = createQueue(QUEUE_NAMES.MODEL_BENCH)
    // Timestamped id: BullMQ never reuses a completed job's id, so a fixed one
    // would allow exactly one bench per Redis lifetime. Serialization comes
    // from the in-flight check above, not from id collision.
    //
    // attempts: 1 OVERRIDES the queue default of 2. That default exists for
    // checkpointed agent runs, where a retry resumes from the last turn; the
    // bench has no checkpoint — a retry re-spends the entire candidates ×
    // fixtures sweep and writes a second copy of every row the first attempt
    // already persisted. The first prod bench did exactly that before this
    // line existed.
    //
    // organizationId rides along so the worker can bill the run's tokens to
    // the operator who clicked the button (ledger surface `eval_bench`) — the
    // ModelEvalResult rows themselves stay platform-level (organizationId:
    // null), this only attributes spend in the LlmCall ledger.
    await queue.add(
      'model-bench',
      { models: models ?? null, organizationId: auth.organizationId },
      { jobId: `model-bench-${Date.now()}`, attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
    )
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError('Unable to queue the bench run', 503, 'QUEUE_UNAVAILABLE', error)
  }
  return { success: true, queued: true, mode: 'queue' }
}, { permission: 'platform.administer', internalOnly: true })

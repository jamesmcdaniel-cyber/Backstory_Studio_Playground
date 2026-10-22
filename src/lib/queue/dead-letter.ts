/**
 * Dead-letter capture for agent jobs.
 *
 * Agent jobs get one retry (see config.ts), and BullMQ emits `failed` after
 * EVERY attempt — including one whose retry is already scheduled. So only the
 * final attempt is handled here: an attempt that recovers on retry was never a
 * dead letter. A final failure is recorded to a dead-letter queue and the
 * execution marked failed in the DB — durable, inspectable, and re-runnable by
 * an operator without silent replay — unless it is a refusal a replay would
 * repeat (see isDeterministicAgentFailure), which the run's owner already sees.
 */

import type { Job } from 'bullmq'
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'
import { AiEgressBlockedError } from '@/lib/security/pii-egress'
import { AgentRunRefusedError, refusedBeforeClaimingRow } from '@/lib/agents/run-errors'
import { createQueue, QUEUE_NAMES } from './config'

export interface DeadLetterInput {
  queue: string
  jobId?: string
  /** Original BullMQ job name, so an operator replay re-enqueues faithfully. */
  jobName?: string
  executionId?: string
  organizationId?: string
  data: unknown
  error: string
}

/**
 * Injectable seams (same pattern as heartbeat.ts's resolveConsumerAlive):
 * production always uses the defaults; tests stub the DB/queue edges so the
 * failure-handling here is assertable without Redis or Postgres.
 */
export interface DeadLetterDeps {
  db: {
    agentExecution: {
      updateMany: (args: {
        where: { id: string; status: { in: string[] } }
        data: { status: string; error: string; completedAt: Date }
      }) => Promise<unknown>
    }
  }
  createQueue: typeof createQueue
  logger: Pick<typeof apiLogger, 'error' | 'warn'>
  capture: typeof captureError
}

const defaultDeps = (): DeadLetterDeps => ({
  db: systemPrisma,
  createQueue,
  logger: apiLogger,
  capture: captureError,
})

/**
 * Stop the owning execution from saying `running` — the half of a dead letter
 * the run's OWNER sees. Split from recordDeadLetter for the same reason as
 * flow-dead-letter.ts's terminalizeDeadLetteredFlowRun: a deterministic
 * refusal deserves this without the operator-facing park.
 *
 * Status-guarded: only a row still `pending` or `running` may be failed here.
 * A job's failure must never overwrite a run that already settled on its own
 * terms (completed, failed with its real reason, cancelled) or paused again
 * for input.
 */
export async function terminalizeDeadLetteredExecution(
  input: DeadLetterInput,
  deps: DeadLetterDeps = defaultDeps(),
): Promise<void> {
  if (!input.executionId) return
  // systemPrisma: id-keyed terminal write from worker job data; execution id was minted org-scoped upstream.
  await deps.db.agentExecution
    .updateMany({
      where: { id: input.executionId, status: { in: ['pending', 'running'] } },
      data: { status: 'failed', error: input.error.slice(0, 300), completedAt: new Date() },
    })
    .catch((error: unknown) => {
      // Still non-throwing — the DLQ enqueue that follows must happen
      // regardless — but never silent: a run stuck `running` forever with no
      // signal is exactly the failure mode dead-lettering exists to prevent.
      deps.logger.error('failed to terminalize dead-lettered agent execution', {
        queue: input.queue,
        jobId: input.jobId,
        executionId: input.executionId,
        error: error instanceof Error ? error.message : String(error),
      })
      deps.capture(error, {
        source: 'dead-letter.terminalize',
        queue: input.queue,
        jobId: input.jobId,
        executionId: input.executionId,
        organizationId: input.organizationId,
      })
    })
}

export async function recordDeadLetter(
  input: DeadLetterInput,
  deps: DeadLetterDeps = defaultDeps(),
): Promise<void> {
  // Best-effort: mark the execution failed so the UI reflects it.
  await terminalizeDeadLetteredExecution(input, deps)

  try {
    const dlq = deps.createQueue(QUEUE_NAMES.DEAD_LETTER)
    await dlq.add('dead-letter', input, { removeOnComplete: false, removeOnFail: false })
  } catch (error) {
    // If even the DLQ enqueue fails, at least log + report — never throw here.
    deps.logger.error('failed to record dead letter', {
      executionId: input.executionId,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  deps.capture(new Error(`agent job dead-lettered: ${input.error}`), {
    queue: input.queue,
    jobId: input.jobId,
    executionId: input.executionId,
    organizationId: input.organizationId,
  })
}

/**
 * Field extraction off a failed job. Pure and exported so the mapping — which
 * decides whether an operator can find and replay the record — is testable
 * without a queue or a database.
 */
export function deadLetterInputFromJob(queueName: string, job: Job, error: Error): DeadLetterInput {
  const data = (job.data ?? {}) as Record<string, unknown>
  return {
    queue: queueName,
    jobId: job.id,
    jobName: job.name,
    executionId: typeof data.executionId === 'string' ? data.executionId : undefined,
    organizationId: typeof data.organizationId === 'string' ? data.organizationId : undefined,
    data: job.data,
    error: error?.message || 'unknown error',
  }
}

/**
 * Whether this `failed` event is the job's last word. BullMQ emits `failed`
 * after every attempt (bullmq Worker.handleFailed, after Job.moveToFailed has
 * already counted the attempt); when a retry is scheduled the job comes back,
 * so the failure is not yet a dead letter. `finishedOn` is stamped only when
 * BullMQ moved the job to the failed set for good, which also covers an
 * UnrecoverableError ending it before its attempts ran out. Shared with the
 * flow dead-letter, whose resume jobs carry the same default of two attempts.
 */
export function isFinalAttempt(job: Pick<Job, 'attemptsMade' | 'opts' | 'finishedOn'>): boolean {
  if (typeof job.finishedOn === 'number') return true
  return (job.attemptsMade ?? 0) >= (job.opts?.attempts ?? 1)
}

/**
 * Failures a dead-letter record can do nothing for — the agent counterpart of
 * flow-dead-letter.ts's isDeterministicUserFailure. A replay of any of these
 * fails identically, and the person who can fix it (the agent's owner, or a
 * workspace admin) already has the message on the run:
 *
 *   - the runtime's typed refusals (AgentRunRefusedError): agent gone or
 *     inactive, the template-copy guards, an execution that does not belong
 *     to this tenant and agent, a resume of a run that is not waiting (the
 *     losing side of two racing replies), the monthly token budget;
 *   - the workspace's AI opt-out (AiEgressBlockedError);
 *   - an `@artifact` request the agent answered without an executable
 *     artifact. That gate throws a plain Error, so it is matched on its
 *     wording — keep the two in step;
 *   - the model provider rejecting the model itself (a 400/404 naming the
 *     model), i.e. a bad model id saved on the agent.
 *
 * Anything unrecognised still parks: the cost of a wrong entry is a lost job
 * record, so each one has to be a failure no operator action could rescue.
 */
export function isDeterministicAgentFailure(error: unknown): boolean {
  if (error instanceof AgentRunRefusedError || error instanceof AiEgressBlockedError) return true
  const message = error instanceof Error ? error.message : ''
  if (/@artifact\b/.test(message) && /executable artifact/.test(message)) return true
  const status = (error as { status?: unknown } | null)?.status
  return (status === 400 || status === 404) && /\bmodel\b/i.test(message)
}

/** Wire onto a Worker's 'failed' event. */
export function deadLetterFromJob(queueName: string, deps?: DeadLetterDeps) {
  return (job: Job | undefined, error: Error) => {
    if (!job) return
    // A retry is scheduled: the next attempt either recovers or comes back here.
    if (!isFinalAttempt(job)) return
    const input = deadLetterInputFromJob(queueName, job, error)
    const resolved = deps ?? defaultDeps()
    if (isDeterministicAgentFailure(error)) {
      // Nothing is parked and nothing is reported: the run row carries the
      // message to the only person who can act on it.
      resolved.logger.warn('agent job refused deterministically — not dead-lettered', {
        queue: input.queue,
        jobId: input.jobId,
        executionId: input.executionId,
        organizationId: input.organizationId,
        error: input.error,
      })
      // A refusal raised before the job claimed its row leaves that row
      // alone: it is another tenant's, does not exist, or is a run another
      // reply already resumed. The rest still stop the run saying `running`.
      if (!refusedBeforeClaimingRow(error)) void terminalizeDeadLetteredExecution(input, resolved)
      return
    }
    void recordDeadLetter(input, resolved)
  }
}

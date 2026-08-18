/**
 * Dead-letter capture for agent jobs.
 *
 * Agent runs are NOT auto-retried (side effects), so a failed job would
 * otherwise leave only its removed BullMQ record. This records failures to a
 * dead-letter queue and marks the execution failed in the DB — durable,
 * inspectable, and re-runnable by an operator without silent replay.
 */

import type { Job } from 'bullmq'
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'
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
      update: (args: {
        where: { id: string }
        data: { status: string; error: string; completedAt: Date }
      }) => Promise<unknown>
    }
  }
  createQueue: typeof createQueue
  logger: Pick<typeof apiLogger, 'error'>
  capture: typeof captureError
}

const defaultDeps = (): DeadLetterDeps => ({
  db: systemPrisma,
  createQueue,
  logger: apiLogger,
  capture: captureError,
})

export async function recordDeadLetter(
  input: DeadLetterInput,
  deps: DeadLetterDeps = defaultDeps(),
): Promise<void> {
  // Best-effort: mark the execution failed so the UI reflects it.
  if (input.executionId) {
    // systemPrisma: id-keyed terminal write from worker job data; execution id was minted org-scoped upstream.
    await deps.db.agentExecution
      .update({
        where: { id: input.executionId },
        data: { status: 'failed', error: input.error.slice(0, 300), completedAt: new Date() },
      })
      .catch((error: unknown) => {
        // Still non-throwing — the DLQ enqueue below must happen regardless —
        // but never silent: a run stuck `running` forever with no signal is
        // exactly the failure mode dead-lettering exists to prevent.
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

/** Wire onto a Worker's 'failed' event. */
export function deadLetterFromJob(queueName: string) {
  return (job: Job | undefined, error: Error) => {
    if (!job) return
    const data = (job.data ?? {}) as Record<string, unknown>
    void recordDeadLetter({
      queue: queueName,
      jobId: job.id,
      jobName: job.name,
      executionId: typeof data.executionId === 'string' ? data.executionId : undefined,
      organizationId: typeof data.organizationId === 'string' ? data.organizationId : undefined,
      data: job.data,
      error: error?.message || 'unknown error',
    })
  }
}

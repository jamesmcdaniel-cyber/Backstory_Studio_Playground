/**
 * Dead-letter capture for flow jobs — mirrors dead-letter.ts but marks the
 * FlowRun row failed instead of an AgentExecution. A run row exists when the
 * job carries flowRunId (a RESUME) or preparedRunId (startFlowExecution
 * created the row before dispatch) — those runs are terminalized here. A
 * plain fresh-execution job (signals/cron) carries neither (runFlowExecution
 * creates that row itself), so its failure is dead-lettered for inspection
 * but has no run row to update.
 */

import type { Job } from 'bullmq'
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'
import { createQueue, QUEUE_NAMES } from './config'

export interface FlowDeadLetterInput {
  queue: string
  jobId?: string
  /** Original BullMQ job name, so an operator replay re-enqueues faithfully. */
  jobName?: string
  flowRunId?: string
  organizationId?: string
  data: unknown
  error: string
}

/** Injectable seams — see dead-letter.ts for the pattern and rationale. */
export interface FlowDeadLetterDeps {
  db: {
    flowRun: {
      updateMany: (args: {
        where: { id: string; status: string }
        data: { status: string; error: string; finishedAt: Date }
      }) => Promise<unknown>
    }
  }
  createQueue: typeof createQueue
  logger: Pick<typeof apiLogger, 'error'>
  capture: typeof captureError
}

const defaultDeps = (): FlowDeadLetterDeps => ({
  db: systemPrisma,
  createQueue,
  logger: apiLogger,
  capture: captureError,
})

export async function recordFlowDeadLetter(
  input: FlowDeadLetterInput,
  deps: FlowDeadLetterDeps = defaultDeps(),
): Promise<void> {
  if (input.flowRunId) {
    // systemPrisma: id-keyed terminal write from worker job data; flow run id was minted org-scoped upstream.
    // Status-guarded: only a run still `running` may be terminalized here. A
    // resume that rolled back to `waiting` (claim rollback), an already-settled
    // run, or a per-attempt BullMQ failure mid-retry must never be clobbered
    // to failed by the dead-letter path.
    await deps.db.flowRun
      .updateMany({
        where: { id: input.flowRunId, status: 'running' },
        data: { status: 'failed', error: input.error.slice(0, 300), finishedAt: new Date() },
      })
      .catch((error: unknown) => {
        // Still non-throwing — the DLQ enqueue below must happen regardless —
        // but never silent: a run stuck `running` forever with no signal is
        // exactly the failure mode dead-lettering exists to prevent.
        deps.logger.error('failed to terminalize dead-lettered flow run', {
          queue: input.queue,
          jobId: input.jobId,
          flowRunId: input.flowRunId,
          error: error instanceof Error ? error.message : String(error),
        })
        deps.capture(error, {
          source: 'flow-dead-letter.terminalize',
          queue: input.queue,
          jobId: input.jobId,
          flowRunId: input.flowRunId,
          organizationId: input.organizationId,
        })
      })
  }

  try {
    const dlq = deps.createQueue(QUEUE_NAMES.FLOW_DEAD_LETTER)
    await dlq.add('dead-letter', input, { removeOnComplete: false, removeOnFail: false })
  } catch (error) {
    deps.logger.error('failed to record flow dead letter', {
      flowRunId: input.flowRunId,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  deps.capture(new Error(`flow job dead-lettered: ${input.error}`), {
    queue: input.queue,
    jobId: input.jobId,
    flowRunId: input.flowRunId,
    organizationId: input.organizationId,
  })
}

/** Pure field extraction — see dead-letter.ts's deadLetterInputFromJob. */
export function flowDeadLetterInputFromJob(queueName: string, job: Job, error: Error): FlowDeadLetterInput {
  const data = (job.data ?? {}) as Record<string, unknown>
  return {
    queue: queueName,
    jobId: job.id,
    jobName: job.name,
    flowRunId:
      typeof data.flowRunId === 'string'
        ? data.flowRunId
        : typeof data.preparedRunId === 'string'
          ? data.preparedRunId
          : undefined,
    organizationId: typeof data.organizationId === 'string' ? data.organizationId : undefined,
    data: job.data,
    error: error?.message || 'unknown error',
  }
}

/** Wire onto a Worker's 'failed' event. */
export function deadLetterFromFlowJob(queueName: string) {
  return (job: Job | undefined, error: Error) => {
    if (!job) return
    void recordFlowDeadLetter(flowDeadLetterInputFromJob(queueName, job, error))
  }
}

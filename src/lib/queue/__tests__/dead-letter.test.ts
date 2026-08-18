import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { QUEUE_NAMES } from '../config'
import { recordDeadLetter, deadLetterFromJob, deadLetterInputFromJob, type DeadLetterDeps } from '../dead-letter'
import {
  recordFlowDeadLetter,
  deadLetterFromFlowJob,
  flowDeadLetterInputFromJob,
  type FlowDeadLetterDeps,
} from '../flow-dead-letter'
import {
  recordTemplateGenerationDeadLetter,
  deadLetterFromTemplateGenerationJob,
  templateGenerationDeadLetterInputFromJob,
  type TemplateGenerationDeadLetterDeps,
} from '../template-generation-dead-letter'

const jobLike = (over: Record<string, unknown> = {}) =>
  ({ id: '1', name: 'a-job', data: {}, ...over }) as never

/**
 * Dead-lettering is the last line before a failure becomes a silence: the job
 * must land in the DLQ *and* the owning run row must stop saying `running`.
 * Both edges are stubbed here — no Redis, no Postgres.
 *
 * The properties that matter and are easy to regress:
 *   * a DB failure must not prevent the DLQ write (and must not be swallowed),
 *   * the flow terminalization stays status-guarded to `running`,
 *   * template generation deliberately terminalizes nothing,
 *   * the original job NAME is carried, or an operator replay re-enqueues
 *     under the wrong name.
 */

interface Added { name: string; data: any; options: any }

function queueRecorder() {
  const added: Record<string, Added[]> = {}
  const createQueue = ((name: string) => ({
    add: async (jobName: string, data: unknown, options: unknown) => {
      ;(added[name] ??= []).push({ name: jobName, data, options })
      return { id: '1' }
    },
  })) as never
  return { added, createQueue }
}

function logRecorder() {
  const errors: { message: string; meta: any }[] = []
  const captured: { error: unknown; context: any }[] = []
  return {
    errors,
    captured,
    logger: { error: (message: string, meta: any) => { errors.push({ message, meta }) } } as never,
    capture: ((error: unknown, context: any) => { captured.push({ error, context }) }) as never,
  }
}

describe('agent dead-letter', () => {
  function harness(update: (args: any) => Promise<unknown> = async () => ({})) {
    const queues = queueRecorder()
    const logs = logRecorder()
    const updates: any[] = []
    const deps: DeadLetterDeps = {
      db: { agentExecution: { update: (args) => { updates.push(args); return update(args) } } },
      createQueue: queues.createQueue,
      logger: logs.logger,
      capture: logs.capture,
    }
    return { deps, queues, logs, updates }
  }

  const input = {
    queue: QUEUE_NAMES.AGENT_EXECUTION,
    jobId: '7',
    jobName: 'execute-agent',
    executionId: 'exec-1',
    organizationId: 'org-1',
    data: { agentId: 'a1' },
    error: 'boom',
  }

  test('the job lands in the DLQ and the execution is marked failed', async () => {
    const { deps, queues, updates } = harness()

    await recordDeadLetter(input, deps)

    assert.equal(updates.length, 1)
    assert.deepEqual(updates[0].where, { id: 'exec-1' })
    assert.equal(updates[0].data.status, 'failed')
    assert.equal(updates[0].data.error, 'boom')
    assert.ok(updates[0].data.completedAt instanceof Date)

    const parked = queues.added[QUEUE_NAMES.DEAD_LETTER]
    assert.equal(parked.length, 1)
    assert.deepEqual(parked[0].data, input)
    // Retention must be off on both ends — a DLQ that trims itself is a DLQ
    // that loses the record an operator came looking for.
    assert.equal(parked[0].options.removeOnComplete, false)
    assert.equal(parked[0].options.removeOnFail, false)
  })

  test('the recorded error is truncated to the column width', async () => {
    const { deps, updates } = harness()

    await recordDeadLetter({ ...input, error: 'x'.repeat(500) }, deps)

    assert.equal(updates[0].data.error.length, 300)
  })

  test('a failed terminalization is logged and reported, never swallowed', async () => {
    // The regression this pins: an execution stuck `running` forever with no
    // signal anywhere is precisely what dead-lettering exists to prevent.
    const { deps, logs, queues } = harness(async () => { throw new Error('db down') })

    await recordDeadLetter(input, deps)

    assert.equal(logs.errors.length, 1)
    assert.match(logs.errors[0].message, /failed to terminalize/)
    assert.equal(logs.errors[0].meta.executionId, 'exec-1')
    assert.ok(logs.captured.some((entry) => entry.context.source === 'dead-letter.terminalize'))
    // …and the DLQ write still happened.
    assert.equal(queues.added[QUEUE_NAMES.DEAD_LETTER].length, 1)
  })

  test('a job with no executionId skips the DB write but still dead-letters', async () => {
    const { deps, updates, queues } = harness()

    await recordDeadLetter({ ...input, executionId: undefined }, deps)

    assert.deepEqual(updates, [])
    assert.equal(queues.added[QUEUE_NAMES.DEAD_LETTER].length, 1)
  })

  test('a DLQ enqueue failure is logged and never thrown at the worker', async () => {
    const logs = logRecorder()
    const deps: DeadLetterDeps = {
      db: { agentExecution: { update: async () => ({}) } },
      createQueue: (() => { throw new Error('redis gone') }) as never,
      logger: logs.logger,
      capture: logs.capture,
    }

    await recordDeadLetter(input, deps)

    assert.match(logs.errors.at(-1)!.message, /failed to record dead letter/)
    // The failure is still reported, so the incident is visible either way.
    assert.ok(logs.captured.length > 0)
  })

  test('the job name and ids are carried off the job', () => {
    // Without jobName an operator replay re-enqueues under a made-up name.
    const mapped = deadLetterInputFromJob(
      QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION,
      jobLike({ id: '9', name: 'execute-scheduled-agent', data: { executionId: 'e1', organizationId: 'o1' } }),
      new Error('kaboom'),
    )

    assert.deepEqual(mapped, {
      queue: QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION,
      jobId: '9',
      jobName: 'execute-scheduled-agent',
      executionId: 'e1',
      organizationId: 'o1',
      data: { executionId: 'e1', organizationId: 'o1' },
      error: 'kaboom',
    })
  })

  test('non-string ids are dropped rather than passed through', () => {
    const mapped = deadLetterInputFromJob(
      QUEUE_NAMES.AGENT_EXECUTION,
      jobLike({ data: { executionId: 42, organizationId: null } }),
      new Error('x'),
    )

    assert.equal(mapped.executionId, undefined)
    assert.equal(mapped.organizationId, undefined)
  })

  test('an error with no message still records something findable', () => {
    assert.equal(deadLetterInputFromJob(QUEUE_NAMES.AGENT_EXECUTION, jobLike(), new Error('')).error, 'unknown error')
  })

  test('the failed-event handler ignores an undefined job', () => {
    // BullMQ emits `failed` with no job when it cannot load one; this must not throw.
    assert.doesNotThrow(() => deadLetterFromJob(QUEUE_NAMES.AGENT_EXECUTION)(undefined, new Error('x')))
  })
})

describe('flow dead-letter', () => {
  function harness(updateMany: (args: any) => Promise<unknown> = async () => ({ count: 1 })) {
    const queues = queueRecorder()
    const logs = logRecorder()
    const updates: any[] = []
    const deps: FlowDeadLetterDeps = {
      db: { flowRun: { updateMany: (args) => { updates.push(args); return updateMany(args) } } },
      createQueue: queues.createQueue,
      logger: logs.logger,
      capture: logs.capture,
    }
    return { deps, queues, logs, updates }
  }

  const input = {
    queue: QUEUE_NAMES.FLOW_EXECUTION,
    jobId: '3',
    jobName: 'execute-flow',
    flowRunId: 'run-1',
    organizationId: 'org-1',
    data: { flowId: 'f1' },
    error: 'step failed',
  }

  test('the run is failed under a running-status guard and the job is parked', async () => {
    const { deps, queues, updates } = harness()

    await recordFlowDeadLetter(input, deps)

    // The guard is the whole point: a resume that rolled back to `waiting`, or
    // an already-settled run, must not be clobbered to failed from here.
    assert.deepEqual(updates[0].where, { id: 'run-1', status: 'running' })
    assert.equal(updates[0].data.status, 'failed')
    assert.ok(updates[0].data.finishedAt instanceof Date)
    assert.equal(queues.added[QUEUE_NAMES.FLOW_DEAD_LETTER].length, 1)
    assert.deepEqual(queues.added[QUEUE_NAMES.FLOW_DEAD_LETTER][0].data, input)
  })

  test('a fresh-execution job with no run row still dead-letters', async () => {
    const { deps, updates, queues } = harness()

    await recordFlowDeadLetter({ ...input, flowRunId: undefined }, deps)

    assert.deepEqual(updates, [])
    assert.equal(queues.added[QUEUE_NAMES.FLOW_DEAD_LETTER].length, 1)
  })

  test('a failed terminalization is logged and reported, never swallowed', async () => {
    const { deps, logs, queues } = harness(async () => { throw new Error('db down') })

    await recordFlowDeadLetter(input, deps)

    assert.match(logs.errors[0].message, /failed to terminalize/)
    assert.equal(logs.errors[0].meta.flowRunId, 'run-1')
    assert.ok(logs.captured.some((entry) => entry.context.source === 'flow-dead-letter.terminalize'))
    assert.equal(queues.added[QUEUE_NAMES.FLOW_DEAD_LETTER].length, 1)
  })

  test('preparedRunId is used as the run id when flowRunId is absent', () => {
    // startFlowExecution creates the row before dispatch and carries it as
    // preparedRunId; without this fallback that run would hang in `running`.
    const mapped = flowDeadLetterInputFromJob(
      QUEUE_NAMES.FLOW_EXECUTION,
      jobLike({ name: 'execute-flow', data: { preparedRunId: 'prepared-1' } }),
      new Error('x'),
    )

    assert.equal(mapped.flowRunId, 'prepared-1')
    assert.equal(mapped.jobName, 'execute-flow')
  })

  test('flowRunId wins over preparedRunId when both are present', () => {
    const mapped = flowDeadLetterInputFromJob(
      QUEUE_NAMES.FLOW_EXECUTION,
      jobLike({ data: { flowRunId: 'resumed', preparedRunId: 'prepared' } }),
      new Error('x'),
    )

    assert.equal(mapped.flowRunId, 'resumed')
  })

  test('the failed-event handler ignores an undefined job', () => {
    assert.doesNotThrow(() => deadLetterFromFlowJob(QUEUE_NAMES.FLOW_EXECUTION)(undefined, new Error('x')))
  })
})

describe('template-generation dead-letter', () => {
  function harness(createQueue?: never) {
    const queues = queueRecorder()
    const logs = logRecorder()
    const deps: TemplateGenerationDeadLetterDeps = {
      createQueue: createQueue ?? queues.createQueue,
      logger: logs.logger,
      capture: logs.capture,
    }
    return { deps, queues, logs }
  }

  const input = {
    queue: QUEUE_NAMES.TEMPLATE_GENERATION,
    jobId: '5',
    jobName: 'generate-templates',
    organizationId: 'org-1',
    data: { organizationId: 'org-1' },
    error: 'model timeout',
  }

  test('the job is parked and nothing is terminalized', async () => {
    // There is deliberately no db seam on this module at all — generation is
    // additive (one createMany or nothing), so there is no state to own.
    const { deps, queues } = harness()

    await recordTemplateGenerationDeadLetter(input, deps)

    assert.equal(queues.added[QUEUE_NAMES.TEMPLATE_GENERATION_DEAD_LETTER].length, 1)
    assert.deepEqual(queues.added[QUEUE_NAMES.TEMPLATE_GENERATION_DEAD_LETTER][0].data, input)
  })

  test('the failure is reported to error tracking', async () => {
    const { deps, logs } = harness()

    await recordTemplateGenerationDeadLetter(input, deps)

    assert.equal(logs.captured.length, 1)
    assert.match((logs.captured[0].error as Error).message, /template-generation job dead-lettered: model timeout/)
    assert.equal(logs.captured[0].context.organizationId, 'org-1')
  })

  test('a DLQ enqueue failure is logged, not thrown', async () => {
    const { deps, logs } = harness((() => { throw new Error('redis gone') }) as never)

    await recordTemplateGenerationDeadLetter(input, deps)

    assert.match(logs.errors[0].message, /failed to record template-generation dead letter/)
  })

  test('the job name is carried for replay, as it is on the other two queues', () => {
    const mapped = templateGenerationDeadLetterInputFromJob(
      QUEUE_NAMES.TEMPLATE_GENERATION,
      jobLike({ id: '5', name: 'generate-templates', data: { organizationId: 'org-1' } }),
      new Error('x'),
    )

    assert.equal(mapped.jobName, 'generate-templates')
    assert.equal(mapped.organizationId, 'org-1')
  })

  test('the failed-event handler ignores an undefined job', () => {
    assert.doesNotThrow(() =>
      deadLetterFromTemplateGenerationJob(QUEUE_NAMES.TEMPLATE_GENERATION)(undefined, new Error('x')),
    )
  })
})

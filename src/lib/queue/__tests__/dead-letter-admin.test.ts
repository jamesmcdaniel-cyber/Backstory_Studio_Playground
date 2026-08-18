import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { QUEUE_NAMES } from '../config'
import {
  DEAD_LETTER_QUEUES,
  DeadLetterOperationError,
  countDeadLetters,
  dropDeadLetter,
  listDeadLetters,
  parseDeadLetterId,
  replayDeadLetter,
  replayTarget,
  showDeadLetter,
  summarizePayload,
  type DeadLetterAdminDeps,
} from '../dead-letter-admin'

/**
 * The operator surface over the DLQs, driven against stub queues.
 *
 * The property worth defending hardest is the replay target: it is read out of
 * job DATA (i.e. out of Redis) and used to enqueue work, so it is constrained
 * to the queue each DLQ legitimately serves rather than trusted.
 */

interface StubJob {
  id: string
  name?: string
  data: unknown
  attemptsMade?: number
  timestamp?: number
  removed?: boolean
}

function harness(seed: Record<string, StubJob[]> = {}) {
  const store: Record<string, StubJob[]> = { ...seed }
  const enqueued: { queue: string; name: string; data: unknown; options: any }[] = []
  const created: string[] = []

  const deps: DeadLetterAdminDeps = {
    createQueue: ((name: string) => {
      created.push(name)
      const wrap = (job: StubJob) => ({
        ...job,
        remove: async () => { job.removed = true },
      })
      return {
        getJobs: async () => (store[name] ?? []).filter((job) => !job.removed).map(wrap),
        getJob: async (id: string) => {
          const job = (store[name] ?? []).find((entry) => entry.id === id && !entry.removed)
          return job ? wrap(job) : undefined
        },
        getJobCounts: async () => ({ waiting: (store[name] ?? []).filter((job) => !job.removed).length }),
        add: async (jobName: string, data: unknown, options: unknown) => {
          enqueued.push({ queue: name, name: jobName, data, options })
          return { id: 'new-1' }
        },
        close: async () => {},
      }
    }) as never,
  }
  return { deps, store, enqueued, created }
}

const record = (over: Record<string, unknown> = {}) => ({
  queue: QUEUE_NAMES.AGENT_EXECUTION,
  jobId: '7',
  jobName: 'execute-agent',
  executionId: 'exec-1',
  organizationId: 'org-1',
  data: { agentId: 'a1', input: 'go' },
  error: 'boom',
  ...over,
})

describe('id parsing', () => {
  test('a well-formed id splits into queue and job', () => {
    assert.deepEqual(parseDeadLetterId('agent-dead-letter:41'), { dlq: 'agent-dead-letter', jobId: '41' })
  })

  test('an unknown queue is refused', () => {
    assert.throws(() => parseDeadLetterId('flow-execution:1'), DeadLetterOperationError)
  })

  test('a bare job id is refused', () => {
    assert.throws(() => parseDeadLetterId('41'), /Not a dead-letter id/)
  })

  test('an empty job id is refused', () => {
    assert.throws(() => parseDeadLetterId('agent-dead-letter:'), DeadLetterOperationError)
  })

  test('all three dead-letter queues are addressable', () => {
    assert.deepEqual(DEAD_LETTER_QUEUES, [
      QUEUE_NAMES.DEAD_LETTER,
      QUEUE_NAMES.FLOW_DEAD_LETTER,
      QUEUE_NAMES.TEMPLATE_GENERATION_DEAD_LETTER,
    ])
    for (const dlq of DEAD_LETTER_QUEUES) {
      assert.equal(parseDeadLetterId(`${dlq}:1`).dlq, dlq)
    }
  })
})

describe('replay target', () => {
  test('each DLQ only admits the queues it serves', () => {
    assert.equal(replayTarget(QUEUE_NAMES.DEAD_LETTER, { queue: QUEUE_NAMES.AGENT_EXECUTION }), QUEUE_NAMES.AGENT_EXECUTION)
    assert.equal(
      replayTarget(QUEUE_NAMES.DEAD_LETTER, { queue: QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION }),
      QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION,
    )
    assert.equal(replayTarget(QUEUE_NAMES.FLOW_DEAD_LETTER, { queue: QUEUE_NAMES.FLOW_EXECUTION }), QUEUE_NAMES.FLOW_EXECUTION)
  })

  test('a record naming another DLQ’s queue is not replayable', () => {
    // Cross-queue replay would run a flow job through the agent handler.
    assert.equal(replayTarget(QUEUE_NAMES.DEAD_LETTER, { queue: QUEUE_NAMES.FLOW_EXECUTION }), null)
  })

  test('an arbitrary queue name out of job data is refused', () => {
    assert.equal(replayTarget(QUEUE_NAMES.DEAD_LETTER, { queue: 'attacker-controlled' }), null)
    assert.equal(replayTarget(QUEUE_NAMES.DEAD_LETTER, {}), null)
  })
})

describe('payload summary', () => {
  test('an object is summarised by its keys, not dumped', () => {
    assert.equal(summarizePayload({ a: 1, b: 2 }), '{ a, b }')
  })

  test('a wide object is truncated', () => {
    const wide = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]))
    assert.match(summarizePayload(wide), /…/)
  })

  test('arrays, primitives and absence each read sensibly', () => {
    assert.equal(summarizePayload([1, 2, 3]), 'array(3)')
    assert.equal(summarizePayload('hello'), 'hello')
    assert.equal(summarizePayload(undefined), 'none')
    assert.equal(summarizePayload({}), '{}')
  })
})

describe('list', () => {
  test('records are summarised across every DLQ, newest first', async () => {
    const { deps } = harness({
      [QUEUE_NAMES.DEAD_LETTER]: [{ id: '1', data: record(), timestamp: 1_000 }],
      [QUEUE_NAMES.FLOW_DEAD_LETTER]: [
        { id: '2', data: record({ queue: QUEUE_NAMES.FLOW_EXECUTION, flowRunId: 'run-1', executionId: undefined }), timestamp: 5_000 },
      ],
    })

    const records = await listDeadLetters({}, deps)

    assert.deepEqual(records.map((entry) => entry.id), ['flow-dead-letter:2', 'agent-dead-letter:1'])
    assert.equal(records[1].queue, QUEUE_NAMES.AGENT_EXECUTION)
    assert.equal(records[1].executionId, 'exec-1')
    assert.equal(records[1].failedReason, 'boom')
    assert.equal(records[1].payloadSummary, '{ agentId, input }')
    assert.equal(records[1].replayable, true)
    assert.equal(records[1].timestamps.enqueuedAt, new Date(1_000).toISOString())
  })

  test('a single DLQ can be listed on its own', async () => {
    const { deps } = harness({
      [QUEUE_NAMES.DEAD_LETTER]: [{ id: '1', data: record() }],
      [QUEUE_NAMES.FLOW_DEAD_LETTER]: [{ id: '2', data: record() }],
    })

    const records = await listDeadLetters({ dlq: QUEUE_NAMES.FLOW_DEAD_LETTER }, deps)

    assert.deepEqual(records.map((entry) => entry.id), ['flow-dead-letter:2'])
  })

  test('an unknown DLQ name is refused rather than silently empty', async () => {
    const { deps } = harness()
    await assert.rejects(() => listDeadLetters({ dlq: 'nope' }, deps), DeadLetterOperationError)
  })

  test('a record whose payload is truncated or malformed still lists', async () => {
    const { deps } = harness({ [QUEUE_NAMES.DEAD_LETTER]: [{ id: '1', data: {} }] })

    const [entry] = await listDeadLetters({ dlq: QUEUE_NAMES.DEAD_LETTER }, deps)

    assert.equal(entry.queue, null)
    assert.equal(entry.replayable, false)
    assert.equal(entry.failedReason, null)
    assert.equal(entry.payloadSummary, 'none')
  })
})

describe('counts', () => {
  test('the total spans every DLQ', async () => {
    const { deps } = harness({
      [QUEUE_NAMES.DEAD_LETTER]: [{ id: '1', data: record() }, { id: '2', data: record() }],
      [QUEUE_NAMES.TEMPLATE_GENERATION_DEAD_LETTER]: [{ id: '3', data: record() }],
    })

    const counts = await countDeadLetters(deps)

    assert.equal(counts.total, 3)
    assert.equal(counts.queues.length, 3)
    assert.equal(counts.queues.find((row) => row.queue === QUEUE_NAMES.DEAD_LETTER)?.waiting, 2)
  })
})

describe('show', () => {
  test('the full original payload is returned', async () => {
    const { deps } = harness({ [QUEUE_NAMES.DEAD_LETTER]: [{ id: '1', data: record(), attemptsMade: 2 }] })

    const detail = await showDeadLetter('agent-dead-letter:1', deps)

    assert.deepEqual(detail.payload, { agentId: 'a1', input: 'go' })
    assert.equal(detail.attemptsMade, 2)
  })

  test('a missing record is a 404, not an empty object', async () => {
    const { deps } = harness()
    await assert.rejects(
      () => showDeadLetter('agent-dead-letter:404', deps),
      (error: DeadLetterOperationError) => error.status === 404 && error.code === 'DEAD_LETTER_NOT_FOUND',
    )
  })
})

describe('replay', () => {
  test('the job is re-enqueued onto its original queue and then removed', async () => {
    const { deps, store, enqueued } = harness({ [QUEUE_NAMES.DEAD_LETTER]: [{ id: '1', data: record() }] })

    const result = await replayDeadLetter('agent-dead-letter:1', deps)

    assert.deepEqual(enqueued, [{
      queue: QUEUE_NAMES.AGENT_EXECUTION,
      name: 'execute-agent',
      data: { agentId: 'a1', input: 'go' },
      options: { attempts: 2, backoff: { type: 'fixed', delay: 2_000 } },
    }])
    assert.equal(store[QUEUE_NAMES.DEAD_LETTER][0].removed, true, 'the DLQ record must be cleared')
    assert.deepEqual(result, {
      id: 'agent-dead-letter:1',
      queue: QUEUE_NAMES.AGENT_EXECUTION,
      jobName: 'execute-agent',
      newJobId: 'new-1',
    })
  })

  test('a scheduled-agent record replays onto the scheduled queue, not the ad-hoc one', async () => {
    const { deps, enqueued } = harness({
      [QUEUE_NAMES.DEAD_LETTER]: [
        { id: '1', data: record({ queue: QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION, jobName: 'execute-scheduled-agent' }) },
      ],
    })

    await replayDeadLetter('agent-dead-letter:1', deps)

    assert.equal(enqueued[0].queue, QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION)
    assert.equal(enqueued[0].name, 'execute-scheduled-agent')
  })

  test('a record written before jobName existed replays under the queue’s known name', async () => {
    const { deps, enqueued } = harness({
      [QUEUE_NAMES.FLOW_DEAD_LETTER]: [{ id: '1', data: record({ queue: QUEUE_NAMES.FLOW_EXECUTION, jobName: undefined }) }],
    })

    await replayDeadLetter('flow-dead-letter:1', deps)

    assert.equal(enqueued[0].name, 'execute-flow')
  })

  test('a record with no valid origin queue is refused, and is NOT removed', async () => {
    const { deps, store, enqueued } = harness({
      [QUEUE_NAMES.DEAD_LETTER]: [{ id: '1', data: record({ queue: 'somewhere-else' }) }],
    })

    await assert.rejects(
      () => replayDeadLetter('agent-dead-letter:1', deps),
      (error: DeadLetterOperationError) => error.code === 'DEAD_LETTER_NOT_REPLAYABLE' && error.status === 409,
    )
    assert.deepEqual(enqueued, [])
    assert.notEqual(store[QUEUE_NAMES.DEAD_LETTER][0].removed, true, 'a refused replay must not destroy the record')
  })

  test('a missing record cannot be replayed', async () => {
    const { deps, enqueued } = harness()
    await assert.rejects(() => replayDeadLetter('agent-dead-letter:9', deps), DeadLetterOperationError)
    assert.deepEqual(enqueued, [])
  })
})

describe('drop', () => {
  test('the record is removed', async () => {
    const { deps, store } = harness({ [QUEUE_NAMES.DEAD_LETTER]: [{ id: '1', data: record() }] })

    assert.deepEqual(await dropDeadLetter('agent-dead-letter:1', deps), { id: 'agent-dead-letter:1' })
    assert.equal(store[QUEUE_NAMES.DEAD_LETTER][0].removed, true)
  })

  test('dropping an unknown record is an error, not a silent success', async () => {
    const { deps } = harness()
    await assert.rejects(
      () => dropDeadLetter('agent-dead-letter:1', deps),
      (error: DeadLetterOperationError) => error.status === 404,
    )
  })

  test('a dropped record no longer lists', async () => {
    const { deps } = harness({ [QUEUE_NAMES.DEAD_LETTER]: [{ id: '1', data: record() }] })

    await dropDeadLetter('agent-dead-letter:1', deps)

    assert.deepEqual(await listDeadLetters({ dlq: QUEUE_NAMES.DEAD_LETTER }, deps), [])
  })
})

test('queue handles are reused rather than reopened per call', async () => {
  // Each BullMQ Queue holds its own Redis client; a handle per call would leak
  // one connection per operator request.
  const { deps, created } = harness({ [QUEUE_NAMES.DEAD_LETTER]: [{ id: '1', data: record() }] })

  await listDeadLetters({ dlq: QUEUE_NAMES.DEAD_LETTER }, deps)
  await listDeadLetters({ dlq: QUEUE_NAMES.DEAD_LETTER }, deps)

  assert.deepEqual(created, [QUEUE_NAMES.DEAD_LETTER])
})

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Real Redis round-trip for the dead-letter operator surface.
 *
 * The stubbed suite (dead-letter-admin.test.ts) pins the decisions; this one
 * proves they survive contact with BullMQ — job ids come back the shape the
 * ids assume, `getJobs` finds a record nothing consumes, and a replay really
 * does land on the origin queue.
 *
 * Gated on TEST_REDIS_URL. When it is absent every case SKIPS VISIBLY (t.skip),
 * rather than the file registering zero tests and reporting green — a silent
 * pass here would mean the queue plane's only integration coverage could
 * disappear without anyone noticing.
 */

const TEST_REDIS_URL = process.env.TEST_REDIS_URL
if (TEST_REDIS_URL) process.env.REDIS_URL = TEST_REDIS_URL

/** Unique per run so a shared CI Redis can host concurrent jobs safely. */
const RUN_ID = `dlq-test-${process.pid}-${Date.now()}`

async function withQueues() {
  const { createQueue, QUEUE_NAMES, getRedisConnection } = await import('../config')
  const admin = await import('../dead-letter-admin')
  return { createQueue, QUEUE_NAMES, getRedisConnection, admin }
}

const cleanups: (() => Promise<void>)[] = []

after(async () => {
  for (const cleanup of cleanups) await cleanup().catch(() => {})
})

describe('dead-letter admin against live Redis', () => {
  test('a recorded dead letter is listable, showable, replayable and droppable', async (t) => {
    if (!TEST_REDIS_URL) return t.skip('TEST_REDIS_URL not set — skipping live Redis round-trip')

    const { createQueue, QUEUE_NAMES, admin } = await withQueues()
    const { recordDeadLetter } = await import('../dead-letter')

    const dlq = createQueue(QUEUE_NAMES.DEAD_LETTER)
    const origin = createQueue(QUEUE_NAMES.AGENT_EXECUTION)
    cleanups.push(async () => {
      await dlq.close()
      await origin.close()
      await admin.closeDeadLetterHandles()
    })

    // Record through the production path, with only the DB edge stubbed.
    await recordDeadLetter(
      {
        queue: QUEUE_NAMES.AGENT_EXECUTION,
        jobName: 'execute-agent',
        executionId: RUN_ID,
        organizationId: 'org-live',
        data: { agentId: RUN_ID, marker: RUN_ID },
        error: 'live round-trip',
      },
      {
        db: { agentExecution: { update: async () => ({}) } },
        createQueue,
        logger: { error: () => {} } as never,
        capture: (() => {}) as never,
      },
    )

    const listed = await admin.listDeadLetters({ dlq: QUEUE_NAMES.DEAD_LETTER, limit: 200 })
    const mine = listed.find((entry) => entry.executionId === RUN_ID)
    assert.ok(mine, 'the recorded dead letter must be listed')
    assert.equal(mine.queue, QUEUE_NAMES.AGENT_EXECUTION)
    assert.equal(mine.replayable, true)
    assert.equal(mine.failedReason, 'live round-trip')

    const detail = await admin.showDeadLetter(mine.id)
    assert.deepEqual(detail.payload, { agentId: RUN_ID, marker: RUN_ID })

    const replayed = await admin.replayDeadLetter(mine.id)
    assert.equal(replayed.queue, QUEUE_NAMES.AGENT_EXECUTION)
    assert.ok(replayed.newJobId, 'the replay must produce a real job id')

    // The DLQ record is gone…
    const after = await admin.listDeadLetters({ dlq: QUEUE_NAMES.DEAD_LETTER, limit: 200 })
    assert.equal(after.some((entry) => entry.id === mine.id), false)

    // …and the work is really on the origin queue.
    const replayedJob = await origin.getJob(replayed.newJobId!)
    assert.ok(replayedJob, 'the replayed job must exist on the origin queue')
    assert.equal(replayedJob.name, 'execute-agent')
    assert.deepEqual(replayedJob.data, { agentId: RUN_ID, marker: RUN_ID })
    assert.equal(replayedJob.opts.attempts, 2, 'a replay gets a fresh attempt budget')
    await replayedJob.remove()
  })

  test('drop removes a record without enqueueing anything', async (t) => {
    if (!TEST_REDIS_URL) return t.skip('TEST_REDIS_URL not set — skipping live Redis round-trip')

    const { createQueue, QUEUE_NAMES, admin } = await withQueues()
    const dlq = createQueue(QUEUE_NAMES.FLOW_DEAD_LETTER)
    cleanups.push(async () => { await dlq.close() })

    const job = await dlq.add(
      'dead-letter',
      { queue: QUEUE_NAMES.FLOW_EXECUTION, flowRunId: `${RUN_ID}-drop`, data: {}, error: 'to drop' },
      { removeOnComplete: false, removeOnFail: false },
    )

    await admin.dropDeadLetter(`${QUEUE_NAMES.FLOW_DEAD_LETTER}:${job.id}`)

    assert.equal(await dlq.getJob(job.id!), undefined)
  })

  test('counts reflect what is parked', async (t) => {
    if (!TEST_REDIS_URL) return t.skip('TEST_REDIS_URL not set — skipping live Redis round-trip')

    const { createQueue, QUEUE_NAMES, admin } = await withQueues()
    const dlq = createQueue(QUEUE_NAMES.TEMPLATE_GENERATION_DEAD_LETTER)
    cleanups.push(async () => { await dlq.close() })

    const before = await admin.countDeadLetters()
    const job = await dlq.add(
      'dead-letter',
      { queue: QUEUE_NAMES.TEMPLATE_GENERATION, organizationId: `${RUN_ID}-count`, data: {}, error: 'counted' },
      { removeOnComplete: false, removeOnFail: false },
    )

    const during = await admin.countDeadLetters()
    assert.equal(during.total, before.total + 1)

    await admin.dropDeadLetter(`${QUEUE_NAMES.TEMPLATE_GENERATION_DEAD_LETTER}:${job.id}`)
    assert.equal((await admin.countDeadLetters()).total, before.total)
  })
})

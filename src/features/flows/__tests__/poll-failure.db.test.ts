import { test, before } from 'node:test'
import assert from 'node:assert/strict'

/**
 * A poll that cannot run — a write tool, one held for approval, a connection
 * that is gone — used to leave only a server log line, so a published flow
 * just never fired. The failure now sits on the cursor, where the builder
 * reads it, without losing the cursor's seen keys; a good check clears it.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let runFlowPoll: any
  let serializeFlow: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ runFlowPoll } = await import('../poll-dispatch'))
    ;({ serializeFlow } = await import('@/lib/flows/serialize'))
    const stamp = Date.now()
    const org = await prisma.organization.create({ data: { name: 'Poll failure', slug: `poll-failure-${stamp}` } })
    ids.org = org.id
    const user = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), email: `poll-failure-${stamp}@example.com`, name: 'P', organizationId: org.id },
    })
    ids.user = user.id
  })

  const mkPollFlow = (trigger: Record<string, unknown>, pollCursor?: unknown) =>
    prisma.flow.create({
      data: {
        name: 'Poll',
        organizationId: ids.org,
        userId: ids.user,
        status: 'ACTIVE',
        graph: { nodes: [], edges: [] },
        publishedGraph: { nodes: [], edges: [] },
        trigger: { type: 'poll', schedule: { type: 'hourly', isActive: true }, ...trigger },
        ...(pollCursor ? { pollCursor } : {}),
      },
    })
  const reload = (id: string) => prisma.flow.findFirstOrThrow({ where: { id, organizationId: ids.org } })

  test('a connection that no longer resolves is recorded, keeping the seen keys', async () => {
    const flow = await mkPollFlow({ connectionId: 'gone-connection', toolName: 'list' }, { seen: ['a'] })
    const now = new Date()
    assert.deepEqual(await runFlowPoll(flow, ids.user, now), { dispatched: 0 })
    const stored = await reload(flow.id)
    assert.deepEqual(stored.pollCursor.seen, ['a'], 'a failure is not a re-baseline')
    assert.equal(stored.pollCursor.lastPolledAt, now.toISOString(), 'retries on its cadence, not every tick')
    assert.match(stored.pollCursor.lastError.message, /no longer exists/)
    assert.match(serializeFlow(stored).pollFailure.message, /no longer exists/, 'the builder is told')
  })

  test('a write tool is refused visibly, and a good check clears the failure', async () => {
    const flow = await mkPollFlow({ connectionId: 'native:data_tables', toolName: 'data_table_create_table' })
    await runFlowPoll(flow, ids.user, new Date())
    let stored = await reload(flow.id)
    assert.match(stored.pollCursor.lastError.message, /only runs read actions/)
    assert.equal(stored.pollCursor.seen, undefined, 'no seen keys were ever learned')

    const fixed = await prisma.flow.update({
      where: { id: flow.id, organizationId: ids.org },
      data: { trigger: { ...stored.trigger, toolName: 'data_table_list_tables' } },
    })
    assert.deepEqual(await runFlowPoll(fixed, ids.user, new Date()), { dispatched: 0 }, 'a failure-only cursor still baselines')
    stored = await reload(flow.id)
    assert.equal(stored.pollCursor.lastError, undefined)
    assert.ok(Array.isArray(stored.pollCursor.seen))
    assert.equal(serializeFlow(stored).pollFailure, null)
  })

  test('a cursor computed for a read that was republished away is not written back', async () => {
    const flow = await mkPollFlow({ connectionId: 'native:data_tables', toolName: 'data_table_list_tables' })
    // Publish moved the poll to another read (and dropped the cursor) while
    // this poll — holding the old trigger — was in flight.
    await prisma.flow.update({
      where: { id: flow.id, organizationId: ids.org },
      data: { trigger: { ...flow.trigger, itemsPath: 'tables' } },
    })
    await runFlowPoll(flow, ids.user, new Date())
    assert.equal((await reload(flow.id)).pollCursor, null, 'the new read baselines on its own next poll')
  })
}

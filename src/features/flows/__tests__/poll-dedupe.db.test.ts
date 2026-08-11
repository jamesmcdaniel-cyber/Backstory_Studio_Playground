import { test, before } from 'node:test'
import assert from 'node:assert/strict'

/**
 * poll-dispatch.ts has always dispatched BEFORE persisting its cursor, and its
 * comment promised that "a downstream dedupe is cheaper than silently losing an
 * item". No downstream dedupe existed: a crash between the two re-emitted the
 * item as a fresh run with a new id, hence new idempotency keys, hence the
 * writes fired twice.
 *
 * Stamping the item's identity on the run is what closes that — runScopeKey
 * scopes the ledger by the ITEM, so the second run replays.
 */

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let runScopeKey: any
  let readLedger: any
  let writeLedger: any
  let pollItemKey: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ runScopeKey, readLedger, writeLedger } = await import('@/lib/flows/side-effect-ledger'))
    ;({ pollItemKey } = await import('@/lib/flows/poll'))

    const stamp = Date.now()
    const org = await prisma.organization.create({ data: { name: 'Poll', slug: `poll-${stamp}` } })
    ids.org = org.id
    const user = await prisma.user.create({
      data: {
        supabaseId: crypto.randomUUID(),
        email: `poll-${stamp}@example.com`,
        name: 'P',
        organizationId: org.id,
      },
    })
    ids.user = user.id
    const flow = await prisma.flow.create({
      data: { name: 'Poll flow', organizationId: org.id, userId: user.id, graph: { nodes: [], edges: [] } },
    })
    ids.flow = flow.id
  })

  test('the dispatcher stamps the same identity the cursor dedupes on', () => {
    // Both sides must use pollItemKey or the scope and the cursor disagree:
    // the cursor would consider an item seen while the ledger considered it new.
    const item = { id: 'issue-42', title: 'x' }
    assert.equal(pollItemKey(item, 'id'), 'issue-42')
    const scope = runScopeKey({ id: 'run-1', flowId: ids.flow, trigger: { type: 'poll', dedupeValue: pollItemKey(item, 'id') } })
    assert.equal(scope, `${ids.flow}:issue-42`)
  })

  test('a keyless item still gets a stable identity via the fallback hash', () => {
    const item = { title: 'no id field' }
    const first = pollItemKey(item, 'id')
    const second = pollItemKey({ title: 'no id field' }, 'id')
    assert.equal(first, second)
    assert.match(first, /^h[0-9a-z]+$/)
  })

  test('two runs for the same polled item replay rather than re-firing the write', async () => {
    const item = { id: `issue-${Date.now()}` }
    const dedupeValue = pollItemKey(item, 'id')
    const first = runScopeKey({ id: 'run-a', flowId: ids.flow, trigger: { type: 'poll', dedupeValue } })
    const second = runScopeKey({ id: 'run-b', flowId: ids.flow, trigger: { type: 'poll', dedupeValue } })

    await writeLedger({
      scopeKey: first,
      iterationKey: 'notify',
      page: 0,
      organizationId: ids.org,
      provider: 'slack',
      tool: 'slack_post_message',
      result: { ok: true, ts: '1.1' },
      flowRunId: null,
    })

    const replay = await readLedger({
      scopeKey: second,
      iterationKey: 'notify',
      page: 0,
      organizationId: ids.org,
    })
    assert.deepEqual(replay, { result: { ok: true, ts: '1.1' } })
  })

  test('a batch poll run has no dedupeValue and stays run-scoped', () => {
    // No single item to key on — falls back to today's behavior rather than
    // collapsing every batch run of one flow into a shared scope.
    const a = runScopeKey({ id: 'run-a', flowId: ids.flow, trigger: { type: 'poll' } })
    const b = runScopeKey({ id: 'run-b', flowId: ids.flow, trigger: { type: 'poll' } })
    assert.equal(a, 'run-a')
    assert.notEqual(a, b)
  })

  test('poll runs carry no scheduledFor, so the occurrence index never binds them', async () => {
    // Their cadence is pollCursor.lastPolledAt, not an occurrence grid; two
    // poll runs of one flow must be able to coexist.
    for (let i = 0; i < 2; i += 1) {
      await prisma.flowRun.create({
        data: { flowId: ids.flow, organizationId: ids.org, userId: ids.user, trigger: { type: 'poll' } },
      })
    }
    const rows = await prisma.flowRun.findMany({
      where: { flowId: ids.flow, organizationId: ids.org, scheduledFor: null },
    })
    assert.ok(rows.length >= 2)
  })
}

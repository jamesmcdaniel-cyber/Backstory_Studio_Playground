import { test, before } from 'node:test'
import assert from 'node:assert/strict'

/**
 * DB-backed coverage for the cursor-checkpointed Slack backfill worker
 * (src/lib/activity/backfill.ts, Task 7 of the activity-event substrate
 * plan): persists a page with `backfill: true`, advances the cursor only
 * after persisting, re-ingests idempotently across a simulated crash window,
 * respects the per-job event cap, and never writes an `activity.dispatch`
 * outbox row. Runs only against TEST_DATABASE_URL — CI-mode DB suite, not the
 * local gate.
 */

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let systemPrisma: any
  let runActivityBackfill: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma, systemPrisma } = await import('@/lib/prisma'))
    ;({ runActivityBackfill } = await import('../backfill'))

    const stamp = Date.now()
    const org = await prisma.organization.create({ data: { name: 'Activity Backfill', slug: `activity-backfill-${stamp}` } })
    ids.org = org.id
  })

  /** A fresh 'connected' Slack NangoConnection row, one per test so pages/
   *  cursors from one test never bleed into another. */
  async function makeConnection(suffix: string) {
    const connection = await systemPrisma.nangoConnection.create({
      data: { organizationId: ids.org, connectionId: `conn-${suffix}`, providerConfigKey: 'slack', status: 'connected' },
    })
    return connection.connectionId as string
  }

  function slackMessage(ts: string, text = 'hello') {
    return { type: 'message', user: 'U100', text, ts }
  }

  test('persists a page as backfill:true rows, advances the cursor, and fires no dispatch outbox row', async () => {
    const connectionId = await makeConnection('page')
    const messages = [slackMessage('1691000001.000001'), slackMessage('1691000002.000002'), slackMessage('1691000003.000003')]

    const proxy = async (args: { endpoint: string }) => {
      if (args.endpoint === '/conversations.list') return { data: { ok: true, channels: [{ id: 'C1' }] } }
      if (args.endpoint === '/conversations.history') return { data: { ok: true, messages, response_metadata: {} } }
      throw new Error(`unexpected endpoint ${args.endpoint}`)
    }

    const result = await runActivityBackfill(ids.org, 'slack', connectionId, { proxy })
    assert.equal(result.status, 'ok')
    assert.equal(result.persisted, 3)
    assert.equal(result.pages, 1)

    const events = await prisma.activityEvent.findMany({ where: { organizationId: ids.org, source: 'slack' } })
    assert.equal(events.length, 3)
    for (const event of events) {
      assert.equal(event.backfill, true)
      assert.equal(event.chainDepth, 0)
    }

    // No trigger dispatch — backfill never fires the outbox at all, not even
    // one the dispatcher would later skip.
    const outboxCount = await systemPrisma.outboxEvent.count({ where: { organizationId: ids.org } })
    assert.equal(outboxCount, 0)

    const cursorRow = await systemPrisma.activitySourceCursor.findUnique({
      where: { organizationId_source_connectionId: { organizationId: ids.org, source: 'slack', connectionId } },
    })
    assert.ok(cursorRow)
    assert.equal(cursorRow.cursor.listed, true)
    assert.equal(cursorRow.cursor.channels[0].done, true)
  })

  test('a crash between persist and cursor-advance re-ingests idempotently on re-run — no duplicate rows', async () => {
    const connectionId = await makeConnection('crash')
    const messages = [slackMessage('1691000101.000001'), slackMessage('1691000102.000002')]
    const proxy = async (args: { endpoint: string }) => {
      if (args.endpoint === '/conversations.list') return { data: { ok: true, channels: [{ id: 'C1' }] } }
      if (args.endpoint === '/conversations.history') return { data: { ok: true, messages, response_metadata: {} } }
      throw new Error(`unexpected endpoint ${args.endpoint}`)
    }

    const first = await runActivityBackfill(ids.org, 'slack', connectionId, { proxy })
    assert.equal(first.persisted, 2)

    // Simulate a crash that landed the createMany above but never reached the
    // cursor-advance write that would have marked the channel done: roll the
    // stored cursor back to its pre-page shape by hand.
    await systemPrisma.activitySourceCursor.update({
      where: { organizationId_source_connectionId: { organizationId: ids.org, source: 'slack', connectionId } },
      data: { cursor: { channels: [{ id: 'C1', cursor: null, done: false }], listed: true } },
    })

    // Re-run with the SAME transport (same messages, same ts's, so the same
    // sourceEventIds) — this is what an operator retry / job re-delivery
    // after a real crash would do.
    const second = await runActivityBackfill(ids.org, 'slack', connectionId, { proxy })
    assert.equal(second.status, 'ok')
    // createMany's skipDuplicates means the re-ingested page inserts zero NEW
    // rows — the unique index already holds them.
    assert.equal(second.persisted, 0)

    const events = await prisma.activityEvent.findMany({ where: { organizationId: ids.org, source: 'slack', sourceEventId: { in: messages.map((m) => `slack:history:C1:${m.ts}`) } } })
    assert.equal(events.length, 2, 'no duplicate rows after the simulated crash + retry')
  })

  test('respects BACKFILL_MAX_EVENTS_PER_JOB without exhausting a channel that has more history', async () => {
    const connectionId = await makeConnection('cap')
    let historyCalls = 0
    const PAGE_SIZE = 300
    const TOTAL_AVAILABLE_PAGES = 10 // 3000 messages available — more than the 2000 cap

    const proxy = async (args: { endpoint: string; params?: Record<string, unknown> }) => {
      if (args.endpoint === '/conversations.list') return { data: { ok: true, channels: [{ id: 'C-big' }] } }
      if (args.endpoint === '/conversations.history') {
        const page = historyCalls
        historyCalls += 1
        if (page >= TOTAL_AVAILABLE_PAGES) return { data: { ok: true, messages: [], response_metadata: {} } }
        const messages = Array.from({ length: PAGE_SIZE }, (_, i) => slackMessage(`169${page}${String(i).padStart(4, '0')}.000000`))
        return { data: { ok: true, messages, response_metadata: { next_cursor: `page-${page + 1}` } } }
      }
      throw new Error(`unexpected endpoint ${args.endpoint}`)
    }

    const result = await runActivityBackfill(ids.org, 'slack', connectionId, { proxy })
    assert.equal(result.status, 'ok')
    assert.ok(result.persisted >= 2000, `expected at least the 2000 cap, got ${result.persisted}`)
    assert.equal(result.cappedAtEventLimit, true)
    // Stopped well short of walking every available page of this channel's history.
    assert.ok(historyCalls < TOTAL_AVAILABLE_PAGES, `expected to stop early, made ${historyCalls} history calls`)

    const dbCount = await prisma.activityEvent.count({ where: { organizationId: ids.org, source: 'slack', subject: { path: ['channelId'], equals: 'C-big' } } })
    assert.equal(dbCount, result.persisted)
  })

  test('an unknown connectionId reports no-connection without writing any rows', async () => {
    const result = await runActivityBackfill(ids.org, 'slack', 'does-not-exist', {})
    assert.equal(result.status, 'no-connection')
    const cursorRow = await systemPrisma.activitySourceCursor.findFirst({ where: { organizationId: ids.org, connectionId: 'does-not-exist' } })
    assert.equal(cursorRow, null)
  })
} else {
  test('skipped: TEST_DATABASE_URL not set (DB-backed backfill suite)', () => {})
}

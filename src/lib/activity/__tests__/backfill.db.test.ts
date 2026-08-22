import { test, before } from 'node:test'
import assert from 'node:assert/strict'

/**
 * DB-backed coverage for the cursor-checkpointed Slack backfill worker
 * (src/lib/activity/backfill.ts, Task 7 of the activity-event substrate
 * plan): persists a page with `backfill: true`, advances the cursor only
 * after persisting, re-ingests idempotently across a simulated crash window,
 * respects the per-job event cap, never writes an `activity.dispatch` outbox
 * row, backfills the NATIVE Slack plane (Task 4's BYO-app path — no
 * NangoConnection at all) via the `'native'` sentinel connectionId, and
 * collides with a LIVE-ingested event of the same message (the cross-scheme
 * identity fix in normalize.ts) instead of double-inserting it. Runs only
 * against TEST_DATABASE_URL — CI-mode DB suite, not the local gate.
 */

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let prisma: any
  let systemPrisma: any
  let runActivityBackfill: any
  let defaultSlackConnectionId: any
  let NATIVE_SLACK_CONNECTION_ID: string
  let normalizeSlackEvent: any
  let encryptSecret: (v: string) => string
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma, systemPrisma } = await import('@/lib/prisma'))
    ;({ runActivityBackfill, defaultSlackConnectionId, NATIVE_SLACK_CONNECTION_ID } = await import('../backfill'))
    ;({ normalizeSlackEvent } = await import('../normalize'))
    ;({ encryptSecret } = await import('@/lib/crypto/secrets'))

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

  /** A fresh org with ONLY the native (Task-4 BYO-app) Slack plane — an
   *  IntegrationSecret bot token and no NangoConnection at all. */
  async function makeNativeOnlyOrg(suffix: string): Promise<string> {
    const stamp = `${Date.now()}-${suffix}`
    const org = await prisma.organization.create({ data: { name: `Activity Backfill Native ${suffix}`, slug: `activity-backfill-native-${stamp}` } })
    await systemPrisma.integrationSecret.create({
      data: {
        organizationId: org.id,
        provider: 'slack',
        authType: 'api_key',
        authConfig: { apiKey: encryptSecret('xoxb-native-test-token'), teamId: `T-${suffix}`, botUserId: `UBOT-${suffix}` },
        isActive: true,
      },
    })
    return org.id as string
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

    const events = await prisma.activityEvent.findMany({ where: { organizationId: ids.org, source: 'slack', sourceEventId: { in: messages.map((m) => `slack:msg:C1:${m.ts}`) } } })
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

  // ── Native (Task-4 BYO-app) plane — Important finding #1 ──────────────────

  test('the native sentinel connectionId backfills an org with no NangoConnection at all, via its saved bot token', async () => {
    const nativeOrgId = await makeNativeOnlyOrg('page')
    const messages = [slackMessage('1692000001.000001'), slackMessage('1692000002.000002')]
    const seenTokens: string[] = []
    const nativeGet = async (token: string, endpoint: string) => {
      seenTokens.push(token)
      if (endpoint === '/conversations.list') return { ok: true, channels: [{ id: 'C-native' }] }
      if (endpoint === '/conversations.history') return { ok: true, messages, response_metadata: {} }
      throw new Error(`unexpected endpoint ${endpoint}`)
    }

    const result = await runActivityBackfill(nativeOrgId, 'slack', NATIVE_SLACK_CONNECTION_ID, { nativeGet })
    assert.equal(result.status, 'ok')
    assert.equal(result.persisted, 2)
    assert.ok(seenTokens.every((t) => t === 'xoxb-native-test-token'), 'used the decrypted org bot token, not a placeholder')

    const events = await prisma.activityEvent.findMany({ where: { organizationId: nativeOrgId, source: 'slack' } })
    assert.equal(events.length, 2)
    for (const event of events) {
      assert.equal(event.backfill, true)
      assert.equal(event.ownerUserId, null)
      assert.equal(event.visibility, 'org')
    }

    // Cursor row keys on the sentinel exactly like a real connectionId would.
    const cursorRow = await systemPrisma.activitySourceCursor.findUnique({
      where: { organizationId_source_connectionId: { organizationId: nativeOrgId, source: 'slack', connectionId: NATIVE_SLACK_CONNECTION_ID } },
    })
    assert.ok(cursorRow)
  })

  test('the native sentinel with no saved bot token reports no-connection', async () => {
    const org = await prisma.organization.create({ data: { name: 'Activity Backfill Native None', slug: `activity-backfill-native-none-${Date.now()}` } })
    const result = await runActivityBackfill(org.id, 'slack', NATIVE_SLACK_CONNECTION_ID, {})
    assert.equal(result.status, 'no-connection')
  })

  test('defaultSlackConnectionId prefers an existing Nango connection over the native sentinel', async () => {
    const nativeOrgId = await makeNativeOnlyOrg('prefer')
    const bothPlanesResult1 = await defaultSlackConnectionId(nativeOrgId)
    assert.equal(bothPlanesResult1, NATIVE_SLACK_CONNECTION_ID, 'native-only org auto-selects the sentinel')

    const nangoConnectionId = await systemPrisma.nangoConnection
      .create({ data: { organizationId: nativeOrgId, connectionId: 'conn-prefer-nango', providerConfigKey: 'slack', status: 'connected' } })
      .then((c: { connectionId: string }) => c.connectionId)
    const bothPlanesResult2 = await defaultSlackConnectionId(nativeOrgId)
    assert.equal(bothPlanesResult2, nangoConnectionId, 'once a Nango connection exists too, it wins over the native sentinel')
  })

  test('defaultSlackConnectionId returns null when neither plane is configured', async () => {
    const org = await prisma.organization.create({ data: { name: 'Activity Backfill No Slack', slug: `activity-backfill-none-${Date.now()}` } })
    assert.equal(await defaultSlackConnectionId(org.id), null)
  })

  // ── Cross-scheme identity — Important finding #2 ───────────────────────────

  test('a message already ingested LIVE is not duplicated when backfill pages over it', async () => {
    const connectionId = await makeConnection('cross-scheme')
    const ts = '1693000001.000001'
    const channel = 'C-cross'

    // Simulate the live Events API receiver having already persisted this
    // exact message (src/app/api/slack/events/route.ts's own path, minus the
    // HTTP plumbing) — same normalizer, `backfill: false`.
    const liveEnvelope = { event_id: 'Ev-live-1', event: { type: 'message', user: 'U100', channel, ts, text: 'hello' } }
    const liveNormalized = normalizeSlackEvent(ids.org, liveEnvelope, { receivedAt: new Date() })
    await systemPrisma.activityEvent.create({
      data: {
        organizationId: ids.org,
        source: liveNormalized.source,
        sourceEventId: liveNormalized.sourceEventId,
        kind: liveNormalized.kind,
        occurredAt: liveNormalized.occurredAt,
        actorExternalId: liveNormalized.actorExternalId,
        subject: liveNormalized.subject,
        payload: liveNormalized.payload,
        backfill: false,
      },
    })

    const proxy = async (args: { endpoint: string }) => {
      if (args.endpoint === '/conversations.list') return { data: { ok: true, channels: [{ id: channel }] } }
      if (args.endpoint === '/conversations.history') return { data: { ok: true, messages: [slackMessage(ts, 'hello')], response_metadata: {} } }
      throw new Error(`unexpected endpoint ${args.endpoint}`)
    }
    const result = await runActivityBackfill(ids.org, 'slack', connectionId, { proxy })
    assert.equal(result.status, 'ok')
    assert.equal(result.persisted, 0, 'the row already exists under the same sourceEventId — skipDuplicates makes this a no-op')

    const rows = await prisma.activityEvent.findMany({ where: { organizationId: ids.org, source: 'slack', sourceEventId: liveNormalized.sourceEventId } })
    assert.equal(rows.length, 1, 'exactly one row for this message — no second row from the backfill pass')
    assert.equal(rows[0].backfill, false, 'the surviving row is still the one live ingestion wrote first')
  })
} else {
  test('skipped: TEST_DATABASE_URL not set (DB-backed backfill suite)', () => {})
}

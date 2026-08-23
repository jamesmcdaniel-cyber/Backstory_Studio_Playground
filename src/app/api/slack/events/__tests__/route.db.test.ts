import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

/**
 * Task 4 (activity-event substrate): the Slack Events API receiver — see
 * docs/superpowers/specs/2026-08-21-activity-event-substrate-design.md and
 * .superpowers/sdd/2026-08-21-activity-event-substrate/task-4-brief.md.
 *
 * Covers, against a real Postgres:
 *  - a bad signature (wrong secret) for a KNOWN team_id acks 200 (not 401) —
 *    see the enumeration-oracle ruling in the route's doc comment: this
 *    outcome must be byte-identical to the unknown-team_id ack below, so the
 *    response code itself never reveals whether a workspace is connected.
 *  - a stale timestamp (>5 min old) for a known team_id is the same
 *    ack-not-401 outcome, even with a correct HMAC over the (still-visible)
 *    body.
 *  - `url_verification` echoes the challenge once the signature verifies
 *    (org resolution isn't needed — no team_id on that payload shape); a bad
 *    signature on THAT branch still 401s, since there's no per-workspace
 *    connection state to leak for it.
 *  - a `message` `event_callback` persists an ActivityEvent AND an
 *    `activity.dispatch` outbox row.
 *  - a redelivery of the identical `event_id` (Slack's own retry behavior,
 *    tolerated via `x-slack-retry-num`) acks without a second row in either
 *    table.
 *  - an event authored by the workspace's own bot user id persists with
 *    `selfOrigin: true`.
 *  - an unresolvable `team_id` (no workspace connected) acks 200 rather than
 *    erroring, and writes nothing.
 *
 * The pure signature-correctness assertions (good/bad/stale all verify
 * exactly as expected) live in src/lib/activity/__tests__/slack-verify.test.ts
 * — this file only asserts what the ROUTE does with each outcome.
 */

const TEST_DB = process.env.TEST_DATABASE_URL
const ENABLED = Boolean(TEST_DB)

if (!ENABLED) {
  test('slack events receiver (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}

if (ENABLED) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let systemPrisma: any
  let encryptSecret: (v: string) => string
  const ids: Record<string, string> = {}
  const SIGNING_SECRET = 'test-slack-signing-secret'
  const OTHER_SIGNING_SECRET = 'a-different-workspace-secret'
  const TEAM_ID = 'T_TASK4_TEST'
  const BOT_USER_ID = 'U_TASK4_BOT'

  before(async () => {
    ;({ systemPrisma } = await import('@/lib/prisma'))
    ;({ encryptSecret } = await import('@/lib/crypto/secrets'))

    const stamp = Date.now()
    const org = await systemPrisma.organization.create({ data: { name: 'Slack Events Test', slug: `slack-events-${stamp}` } })
    ids.org = org.id

    await systemPrisma.integrationSecret.create({
      data: {
        organizationId: org.id,
        provider: 'slack',
        authType: 'api_key',
        authConfig: {
          apiKey: encryptSecret('xoxb-test-token'),
          signingSecret: encryptSecret(SIGNING_SECRET),
          teamId: TEAM_ID,
          botUserId: BOT_USER_ID,
        },
        isActive: true,
      },
    })
  })

  after(async () => {
    if (ids.org) {
      await systemPrisma.activityEvent.deleteMany({ where: { organizationId: ids.org } })
      await systemPrisma.outboxEvent.deleteMany({ where: { organizationId: ids.org } })
      await systemPrisma.integrationSecret.deleteMany({ where: { organizationId: ids.org } })
      await systemPrisma.organization.deleteMany({ where: { id: ids.org } })
    }
  })

  function sign(secret: string, timestamp: string, rawBody: string): string {
    const base = `v0:${timestamp}:${rawBody}`
    return `v0=${crypto.createHmac('sha256', secret).update(base, 'utf8').digest('hex')}`
  }

  async function post(body: Record<string, unknown>, opts: { secret?: string; timestamp?: string; badSignature?: boolean } = {}) {
    const raw = JSON.stringify(body)
    const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000))
    const secret = opts.secret ?? SIGNING_SECRET
    const signature = opts.badSignature ? 'v0=' + '0'.repeat(64) : sign(secret, timestamp, raw)
    const { POST } = await import('../route')
    return POST(
      new NextRequest('https://app.test/api/slack/events', {
        method: 'POST',
        body: raw,
        headers: {
          'content-type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
      }),
    )
  }

  // Task 7's cross-scheme identity fix (docs/superpowers/specs/2026-08-21-
  // activity-event-substrate-design.md) makes `sourceEventId` derive from
  // `channel:ts`, not Slack's `event_id`, whenever both are present — which
  // every `message` event carries. So each test needs its OWN `ts` (not the
  // fixed default this file used to hardcode), or every test's envelope would
  // collide on the same persisted row. `nextTs()` hands out a fresh one per
  // call; `slackMsgSourceEventId` builds the same key the route computes, so
  // assertions can look up the row without depending on `event_id` at all.
  let tsSeq = 0
  function nextTs(): string {
    tsSeq += 1
    return `${1700000000 + tsSeq}.000100`
  }
  function slackMsgSourceEventId(channel: string, ts: string): string {
    return `slack:msg:${channel}:${ts}`
  }

  function messageEnvelope(eventId: string, ts: string, overrides: Record<string, unknown> = {}) {
    return {
      token: 'legacy-verification-token',
      team_id: TEAM_ID,
      api_app_id: 'A_TEST',
      type: 'event_callback',
      event_id: eventId,
      event_time: Math.floor(Date.now() / 1000),
      event: {
        type: 'message',
        channel: 'C_GENERAL',
        user: 'U_HUMAN',
        text: 'hello from a test',
        ts,
        ...overrides,
      },
    }
  }

  test('bad signature (wrong secret) for a known team_id acks 200, not 401 (enumeration-oracle fix)', async () => {
    const eventId = `evt-bad-sig-${Date.now()}`
    const ts = nextTs()
    const res = await post(messageEnvelope(eventId, ts), { secret: 'not-the-real-secret' })
    assert.equal(res.status, 200, 'a known team_id\'s failed verification acks identically to an unknown team_id')
    const data = await res.json()
    assert.deepEqual(data, { ok: true }, 'byte-identical ack shape to the unknown-team_id case below')
    const events = await systemPrisma.activityEvent.findMany({ where: { organizationId: ids.org, source: 'slack', sourceEventId: slackMsgSourceEventId('C_GENERAL', ts) } })
    assert.equal(events.length, 0, 'nothing persisted from an unverified request')
  })

  test('stale timestamp (>5 minutes old) for a known team_id also acks 200, not 401', async () => {
    const eventId = `evt-stale-${Date.now()}`
    const ts = nextTs()
    const staleTimestamp = String(Math.floor((Date.now() - 6 * 60_000) / 1000))
    const res = await post(messageEnvelope(eventId, ts), { timestamp: staleTimestamp })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.deepEqual(data, { ok: true })
    const events = await systemPrisma.activityEvent.findMany({ where: { organizationId: ids.org, source: 'slack', sourceEventId: slackMsgSourceEventId('C_GENERAL', ts) } })
    assert.equal(events.length, 0, 'a stale-but-known-team delivery still persists nothing')
  })

  test('url_verification echoes the challenge once verified', async () => {
    const challenge = `chal-${Date.now()}`
    const res = await post({ type: 'url_verification', token: 'legacy-verification-token', challenge })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.challenge, challenge)
  })

  test('url_verification with a bad signature is still rejected 401 (no org to resolve it against)', async () => {
    const res = await post(
      { type: 'url_verification', token: 'legacy-verification-token', challenge: 'chal-bad' },
      { secret: OTHER_SIGNING_SECRET },
    )
    assert.equal(res.status, 401)
  })

  test('message event persists an ActivityEvent and an activity.dispatch outbox row', async () => {
    const eventId = `evt-msg-${Date.now()}`
    const ts = nextTs()
    const res = await post(messageEnvelope(eventId, ts))
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.ok, true)

    const sourceEventId = slackMsgSourceEventId('C_GENERAL', ts)
    const events = await systemPrisma.activityEvent.findMany({ where: { organizationId: ids.org, source: 'slack', sourceEventId } })
    assert.equal(events.length, 1)
    assert.equal(events[0].kind, 'message.posted')
    assert.equal(events[0].ownerUserId, null, 'workspace-shared Slack credential -> org-visible, no owner')
    assert.equal(events[0].visibility, 'org')
    assert.equal(events[0].selfOrigin, false, 'a human user authored this one')

    // The outbox dedupeKey is built from the SAME sourceEventId the row was
    // persisted under (channel:ts now, not event_id) — see activity.ts.
    const outboxRows = await systemPrisma.outboxEvent.findMany({
      where: { organizationId: ids.org, dedupeKey: `activity-dispatch:slack:${sourceEventId}` },
    })
    assert.equal(outboxRows.length, 1)
    assert.equal(outboxRows[0].topic, 'activity.dispatch')
    ids.firstOutboxId = outboxRows[0].id
  })

  test('retry delivery of the identical event_id acks without a second row in either table', async () => {
    const eventId = `evt-retry-${Date.now()}`
    const ts = nextTs()
    const first = await post(messageEnvelope(eventId, ts))
    assert.equal(first.status, 200)

    const raw = JSON.stringify(messageEnvelope(eventId, ts))
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = sign(SIGNING_SECRET, timestamp, raw)
    const { POST } = await import('../route')
    const retry = await POST(
      new NextRequest('https://app.test/api/slack/events', {
        method: 'POST',
        body: raw,
        headers: {
          'content-type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
          // Slack marks redeliveries with this header; the receiver must
          // tolerate it (dedupe makes the retry an ack, not a rejection).
          'x-slack-retry-num': '1',
          'x-slack-retry-reason': 'http_timeout',
        },
      }),
    )
    assert.equal(retry.status, 200, 'a retry delivery still acks 200')
    const retryData = await retry.json()
    assert.equal(retryData.ok, true)

    const sourceEventId = slackMsgSourceEventId('C_GENERAL', ts)
    const events = await systemPrisma.activityEvent.findMany({ where: { organizationId: ids.org, source: 'slack', sourceEventId } })
    assert.equal(events.length, 1, 'still exactly one row — P2002 was swallowed as a dedupe ack')

    const outboxRows = await systemPrisma.outboxEvent.findMany({
      where: { organizationId: ids.org, dedupeKey: `activity-dispatch:slack:${sourceEventId}` },
    })
    assert.equal(outboxRows.length, 1, 'still exactly one outbox row for the retried event')
  })

  test('an event authored by the workspace bot user persists with selfOrigin: true', async () => {
    const eventId = `evt-self-${Date.now()}`
    const ts = nextTs()
    const res = await post(messageEnvelope(eventId, ts, { user: BOT_USER_ID }))
    assert.equal(res.status, 200)

    const events = await systemPrisma.activityEvent.findMany({ where: { organizationId: ids.org, source: 'slack', sourceEventId: slackMsgSourceEventId('C_GENERAL', ts) } })
    assert.equal(events.length, 1)
    assert.equal(events[0].selfOrigin, true, 'authored by the workspace\'s own captured botUserId')
  })

  test('an unresolvable team_id acks 200 and persists nothing (no workspace connected)', async () => {
    const eventId = `evt-unknown-team-${Date.now()}`
    const ts = nextTs()
    const raw = JSON.stringify({ ...messageEnvelope(eventId, ts), team_id: 'T_NEVER_CONNECTED' })
    const timestamp = String(Math.floor(Date.now() / 1000))
    // Signed with SOME secret — since team_id resolves to no org at all, the
    // route never even reaches a signature check for this delivery.
    const signature = sign(SIGNING_SECRET, timestamp, raw)
    const { POST } = await import('../route')
    const res = await POST(
      new NextRequest('https://app.test/api/slack/events', {
        method: 'POST',
        body: raw,
        headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature },
      }),
    )
    assert.equal(res.status, 200, 'unknown team_id acks rather than erroring, per the Nango-webhook precedent')
    const data = await res.json()
    assert.deepEqual(data, { ok: true }, 'byte-identical to a KNOWN team_id\'s failed-verification ack above — no oracle')

    const events = await systemPrisma.activityEvent.findMany({ where: { source: 'slack', sourceEventId: slackMsgSourceEventId('C_GENERAL', ts) } })
    assert.equal(events.length, 0)
  })

  // Finding 6: unknown-team and team-verification-failed must be rate-limited
  // IDENTICALLY (same REJECTED_LIMIT, same key shape) — otherwise a caller
  // can enumerate connected workspaces by noticing WHICH branch starts
  // 429ing after 30 bad requests/min and which doesn't.
  async function postFrom(ip: string, body: Record<string, unknown>, opts: { secret?: string } = {}) {
    const raw = JSON.stringify(body)
    const timestamp = String(Math.floor(Date.now() / 1000))
    const secret = opts.secret ?? SIGNING_SECRET
    const signature = sign(secret, timestamp, raw)
    const { POST } = await import('../route')
    return POST(
      new NextRequest('https://app.test/api/slack/events', {
        method: 'POST',
        body: raw,
        headers: {
          'content-type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
          'x-forwarded-for': ip,
        },
      }),
    )
  }

  test('unknown-team probing hits the same 429 rate limit as a known team with a bad signature', async () => {
    // Deterministic, collision-free IPs (not random) — the in-memory rate
    // limiter is keyed by ip, and two tests racing onto the same random
    // octet would let one test's requests count against the other's budget.
    const stamp = Date.now() % 250
    const unknownIp = `10.6.1.${stamp || 1}`
    const knownIp = `10.6.2.${stamp || 1}`

    let lastUnknown
    for (let i = 0; i < 31; i++) {
      const ts = nextTs()
      lastUnknown = await postFrom(unknownIp, { ...messageEnvelope(`evt-unk-${i}-${Date.now()}`, ts), team_id: 'T_NEVER_CONNECTED_2' })
    }
    assert.equal(lastUnknown!.status, 429, 'the 31st unknown-team probe from one IP must be rate-limited')

    let lastKnownBad
    for (let i = 0; i < 31; i++) {
      const ts = nextTs()
      lastKnownBad = await postFrom(knownIp, messageEnvelope(`evt-badsig-${i}-${Date.now()}`, ts), { secret: 'not-the-real-secret' })
    }
    assert.equal(lastKnownBad!.status, 429, 'the 31st bad-signature probe against a KNOWN team from one IP must be rate-limited identically')

    const unknownBody = await lastUnknown!.json()
    const knownBody = await lastKnownBad!.json()
    assert.deepEqual(unknownBody, knownBody, 'both branches 429 with the identical body shape')
    assert.equal(lastUnknown!.headers.get('retry-after') !== null, true)
    assert.equal(lastKnownBad!.headers.get('retry-after') !== null, true)
  })

  // Finding 3: conversations.history is newest-first, so a backfill walk's
  // first pages can persist a message BEFORE its live Events API delivery
  // arrives. A live delivery of a message backfill already wrote must fire
  // exactly once, not be swallowed as a no-op "redelivery".
  test('a message backfill saw first still fires exactly once when the live delivery arrives', async () => {
    const channel = 'C_BACKFILL_OVERLAP'
    const ts = nextTs()
    const sourceEventId = slackMsgSourceEventId(channel, ts)

    // Simulate the backfill worker having already persisted this message
    // (backfill: true, no outbox row — exactly runActivityBackfill's shape).
    const backfilled = await systemPrisma.activityEvent.create({
      data: {
        organizationId: ids.org,
        source: 'slack',
        sourceEventId,
        kind: 'message.posted',
        occurredAt: new Date(),
        ownerUserId: null,
        visibility: 'org',
        selfOrigin: false,
        backfill: true,
        chainDepth: 0,
        subject: { channelId: channel, ts },
        payload: { text: 'hello' },
      },
    })
    const outboxBefore = await systemPrisma.outboxEvent.findMany({
      where: { organizationId: ids.org, dedupeKey: `activity-dispatch:slack:${sourceEventId}` },
    })
    assert.equal(outboxBefore.length, 0, 'backfill itself never writes an outbox row')

    // Now the LIVE delivery of that same message arrives.
    const eventId = `evt-overlap-${Date.now()}`
    const res = await post(messageEnvelope(eventId, ts, { channel }))
    assert.equal(res.status, 200)

    const row = await systemPrisma.activityEvent.findUnique({ where: { id: backfilled.id } })
    assert.equal(row.backfill, false, 'the row is live now — backfill flipped to false on the collision')

    const outboxAfter = await systemPrisma.outboxEvent.findMany({
      where: { organizationId: ids.org, dedupeKey: `activity-dispatch:slack:${sourceEventId}` },
    })
    assert.equal(outboxAfter.length, 1, 'exactly one outbox row is emitted for the now-live message')
    assert.equal(outboxAfter[0].aggregateId, backfilled.id, 'the outbox row points at the SAME row backfill created, not a new one')

    const total = await systemPrisma.activityEvent.count({ where: { organizationId: ids.org, source: 'slack', sourceEventId } })
    assert.equal(total, 1, 'still exactly one ActivityEvent row — no duplicate insert')

    // A replayed live delivery after that must still ack without firing a
    // second outbox row.
    const replay = await post(messageEnvelope(`evt-overlap-replay-${Date.now()}`, ts, { channel }))
    assert.equal(replay.status, 200)
    const outboxReplay = await systemPrisma.outboxEvent.findMany({
      where: { organizationId: ids.org, dedupeKey: `activity-dispatch:slack:${sourceEventId}` },
    })
    assert.equal(outboxReplay.length, 1, 'replayed live delivery after the flip acks without a second outbox row')
  })
}

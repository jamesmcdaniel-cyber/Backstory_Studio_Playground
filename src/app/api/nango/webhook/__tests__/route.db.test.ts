import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { NextRequest } from 'next/server'

/**
 * Task 3 (activity-event substrate): every sync/forward Nango delivery must
 * persist an ActivityEvent, not just a best-effort outbox signal — see
 * docs/superpowers/specs/2026-08-21-activity-event-substrate-design.md and
 * .superpowers/sdd/2026-08-21-activity-event-substrate/task-3-brief.md.
 *
 * Covers, against a real Postgres:
 *  - a forward event with a mirror row persists an ActivityEvent AND an
 *    outbox row whose dedupeKey is the real `activity:<source>:<id>` triple
 *    (replacing the old `null`).
 *  - a redelivery of the identical event is acked without a second row in
 *    either table (P2002 on both unique keys is treated as "already have
 *    it", not a failure).
 *  - a MIRROR-LESS delivery still persists when the org is recoverable via a
 *    single bounded Nango connection lookup (the org tag set at connect
 *    time) — exercised against a tiny local HTTP stub standing in for the
 *    Nango API, via NANGO_HOST.
 *  - a delivery for a connection Nango itself has no org tag for (or the
 *    lookup fails) is the one remaining drop: WARN-only, no ActivityEvent.
 */

const TEST_DB = process.env.TEST_DATABASE_URL
const ENABLED = Boolean(TEST_DB)

if (!ENABLED) {
  test('nango webhook activity-event persistence (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}

if (ENABLED) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.NANGO_SECRET_KEY = 'test-nango-secret'
  delete process.env.NANGO_HOST // set per-suite below, to the local stub

  let systemPrisma: any
  let stubServer: http.Server
  let stubPort: number
  // connectionId -> the JSON body the stub /connections/:id endpoint returns.
  // Unmapped connectionIds fall through to a 404 (the "Nango has no tag
  // either" case for the drop-WARN test).
  const stubConnections = new Map<string, unknown>()
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ systemPrisma } = await import('@/lib/prisma'))

    stubServer = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const connectionId = url.pathname.split('/').filter(Boolean)[1]
      const body = connectionId ? stubConnections.get(connectionId) : undefined
      res.setHeader('content-type', 'application/json')
      if (!body) {
        res.statusCode = 404
        res.end(JSON.stringify({ error: 'not_found' }))
        return
      }
      res.statusCode = 200
      res.end(JSON.stringify(body))
    })
    await new Promise<void>((resolve) => stubServer.listen(0, '127.0.0.1', resolve))
    stubPort = (stubServer.address() as AddressInfo).port
    process.env.NANGO_HOST = `http://127.0.0.1:${stubPort}`

    const stamp = Date.now()
    const org = await systemPrisma.organization.create({ data: { name: 'Nango Webhook Test', slug: `nango-webhook-${stamp}` } })
    ids.org = org.id
    const user = await systemPrisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: org.id } })
    ids.user = user.id

    ids.connectionMirrored = `conn-mirrored-${stamp}`
    await systemPrisma.nangoConnection.create({
      data: {
        organizationId: org.id,
        connectionId: ids.connectionMirrored,
        providerConfigKey: 'github',
        provider: 'github',
        status: 'connected',
      },
    })

    ids.connectionFallback = `conn-fallback-${stamp}`
    stubConnections.set(ids.connectionFallback, { end_user: { id: user.id }, tags: { org_id: org.id } })

    ids.connectionUnresolvable = `conn-unresolvable-${stamp}`
    // Deliberately no mirror row and no stub mapping — Nango itself has
    // nothing to say about this connectionId either.
  })

  after(async () => {
    await new Promise<void>((resolve) => stubServer.close(() => resolve()))
    if (ids.org) {
      await systemPrisma.activityEvent.deleteMany({ where: { organizationId: ids.org } })
      await systemPrisma.outboxEvent.deleteMany({ where: { organizationId: ids.org } })
      await systemPrisma.nangoConnection.deleteMany({ where: { organizationId: ids.org } })
      await systemPrisma.user.deleteMany({ where: { organizationId: ids.org } })
      await systemPrisma.organization.deleteMany({ where: { id: ids.org } })
    }
  })

  function sign(raw: string): string {
    return crypto.createHmac('sha256', process.env.NANGO_SECRET_KEY as string).update(raw).digest('hex')
  }

  async function post(body: Record<string, unknown>) {
    const raw = JSON.stringify(body)
    const { POST } = await import('../route')
    return POST(
      new NextRequest('https://app.test/api/nango/webhook', {
        method: 'POST',
        body: raw,
        headers: { 'x-nango-hmac-sha256': sign(raw) },
      }),
    )
  }

  test('forward event with a mirror row persists an ActivityEvent and a real-dedupeKey outbox row', async () => {
    const res = await post({
      type: 'forward',
      connectionId: ids.connectionMirrored,
      providerConfigKey: 'github',
      payload: {
        id: 'evt-gh-1',
        action: 'opened',
        pull_request: { number: 42, merged: false },
        repository: { full_name: 'acme/widgets' },
        sender: { login: 'octocat' },
      },
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.ok, true)

    const events = await systemPrisma.activityEvent.findMany({ where: { organizationId: ids.org, source: 'github', sourceEventId: 'evt-gh-1' } })
    assert.equal(events.length, 1, 'exactly one ActivityEvent row for this delivery')
    assert.equal(events[0].kind, 'pr.opened')
    assert.equal(events[0].ownerUserId, null, 'org-owned mirror (no userId) -> null owner')
    assert.equal(events[0].visibility, 'org')

    const outboxRows = await systemPrisma.outboxEvent.findMany({ where: { organizationId: ids.org, dedupeKey: 'activity:github:evt-gh-1' } })
    assert.equal(outboxRows.length, 1, 'outbox row carries the real activity:<source>:<id> dedupeKey')
    ids.firstOutboxId = outboxRows[0].id
  })

  test('redelivery of the identical event is acked without a second row in either table', async () => {
    const res = await post({
      type: 'forward',
      connectionId: ids.connectionMirrored,
      providerConfigKey: 'github',
      payload: {
        id: 'evt-gh-1',
        action: 'opened',
        pull_request: { number: 42, merged: false },
        repository: { full_name: 'acme/widgets' },
        sender: { login: 'octocat' },
      },
    })
    assert.equal(res.status, 200, 'duplicate delivery still returns the same 200/ok shape Nango expects')
    const data = await res.json()
    assert.equal(data.ok, true)

    const events = await systemPrisma.activityEvent.findMany({ where: { organizationId: ids.org, source: 'github', sourceEventId: 'evt-gh-1' } })
    assert.equal(events.length, 1, 'still exactly one row — P2002 was swallowed as a dedupe ack, not a new insert')

    const outboxRows = await systemPrisma.outboxEvent.findMany({ where: { organizationId: ids.org, dedupeKey: 'activity:github:evt-gh-1' } })
    assert.equal(outboxRows.length, 1, 'still exactly one outbox row for the same dedupeKey')
    assert.equal(outboxRows[0].id, ids.firstOutboxId)
  })

  test('mirror-less delivery persists when the org is recoverable from a bounded Nango connection lookup', async () => {
    const res = await post({
      type: 'forward',
      connectionId: ids.connectionFallback,
      providerConfigKey: 'salesforce',
      payload: { id: 'evt-sf-1', recordId: 'rec-1', changeType: 'UPDATE', modifiedById: 'ext-user-1' },
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.ok, true)

    const events = await systemPrisma.activityEvent.findMany({ where: { organizationId: ids.org, source: 'salesforce', sourceEventId: 'evt-sf-1' } })
    assert.equal(events.length, 1, 'org was recoverable from the Nango-side tag even with no mirror row')
    assert.equal(events[0].kind, 'record.updated')
    assert.equal(events[0].ownerUserId, ids.user, 'end_user.id from the recovered connection becomes the owner')
    assert.equal(events[0].visibility, 'private', 'user-attributed connection -> private, not org')

    const outboxRows = await systemPrisma.outboxEvent.findMany({ where: { organizationId: ids.org, dedupeKey: 'activity:salesforce:evt-sf-1' } })
    assert.equal(outboxRows.length, 1)
  })

  test('a connection unresolvable to any organization is the one remaining drop (WARN, no row)', async () => {
    const res = await post({
      type: 'forward',
      connectionId: ids.connectionUnresolvable,
      providerConfigKey: 'github',
      payload: { id: 'evt-gh-unresolvable', action: 'opened', pull_request: { number: 1 }, repository: { full_name: 'acme/x' } },
    })
    assert.equal(res.status, 200, 'still acked so Nango does not retry')
    const data = await res.json()
    assert.equal(data.ok, true)

    const events = await systemPrisma.activityEvent.findMany({ where: { source: 'github', sourceEventId: 'evt-gh-unresolvable' } })
    assert.equal(events.length, 0, 'no organization to attribute the row to -> not persisted anywhere')
  })
}

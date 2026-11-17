import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { randomBytes } from 'node:crypto'

/**
 * Flow.trigger (+ activitySource/activityKinds) is what every firing path
 * reads, and every one of them runs publishedGraph. Draft saves used to
 * re-derive those columns from the DRAFT graph on every autosave, so flipping a
 * published webhook flow's draft to a schedule made production webhooks 409 and
 * set the scheduler running the published graph on the draft's cadence. These
 * pin that only publish (and revert, unpublish) changes a published flow's
 * trigger columns, through every write path that touches them.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENTITLEMENT_GATE = 'off'

  let prisma: any
  let seedTestOrg: any
  let installTestAuth: any
  let hashToken: any
  let flowsRoute: any
  let publishRoute: any
  let versionsRoute: any
  let secretRoute: any
  let v1Route: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth'))
    ;({ hashToken } = await import('@/lib/crypto/secrets'))
    flowsRoute = await import('../route')
    publishRoute = await import('../[id]/publish/route')
    versionsRoute = await import('../[id]/versions/route')
    secretRoute = await import('../[id]/trigger-secret/route')
    v1Route = await import('@/app/api/v1/flows/[id]/route')
  })

  const graphWith = (trigger: Record<string, unknown>) => ({
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger } },
      { id: 'note', type: 'note', data: { text: 'step', color: 'yellow' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'note' }],
  })
  const schedule = { type: 'schedule', schedule: { type: 'daily', time: '09:00', timezone: 'UTC', isActive: true } }
  const poll = (overrides: Record<string, unknown> = {}) => ({
    type: 'poll',
    connectionId: 'native:data_tables',
    toolName: 'data_table_list_tables',
    schedule: { type: 'hourly', isActive: true },
    ...overrides,
  })

  const json = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const put = (body: Record<string, unknown>) => flowsRoute.PUT(new NextRequest(new URL('http://test/api/flows'), json('PUT', body)))
  const publishAction = (id: string, body: Record<string, unknown> = {}) =>
    publishRoute.POST(new NextRequest(new URL(`http://test/api/flows/${id}/publish`), json('POST', body)))
  const restore = (id: string, version: number) =>
    versionsRoute.POST(new NextRequest(new URL(`http://test/api/flows/${id}/versions`), json('POST', { action: 'restore', version })))
  const mint = (id: string) =>
    secretRoute.POST(new NextRequest(new URL(`http://test/api/flows/${id}/trigger-secret`), json('POST', { rotate: true })))
  const row = (id: string, organizationId: string) => prisma.flow.findFirstOrThrow({ where: { id, organizationId } })

  const withOrg = async (body: (seeded: any) => Promise<void>) => {
    const seeded = await seedTestOrg(prisma)
    try {
      installTestAuth(seeded.auth)
      await body(seeded)
    } finally {
      await seeded.cleanup()
      await prisma.organization.delete({ where: { id: seeded.organizationId } }).catch(() => {})
    }
  }
  const mkFlow = (seeded: any, trigger: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    prisma.flow.create({
      data: { organizationId: seeded.organizationId, userId: seeded.userId, name: 'Trigger flow', graph: graphWith(trigger), trigger, ...extra },
    })

  test('a draft save of a published webhook flow leaves the live trigger armed; publish switches it', async () => {
    await withOrg(async (seeded) => {
      const flow = await mkFlow(seeded, { type: 'webhook', webhookSecretHash: 'live-hash' })
      assert.equal((await publishAction(flow.id)).status, 200)

      const saved = await put({ id: flow.id, graph: graphWith(schedule) })
      assert.equal(saved.status, 200)
      let stored = await row(flow.id, seeded.organizationId)
      assert.equal(stored.trigger.type, 'webhook', 'production webhooks keep working while the draft experiments')
      assert.equal(stored.trigger.webhookSecretHash, 'live-hash')
      assert.equal((await saved.json()).flow.trigger.type, 'webhook', 'the wire trigger is the live one')

      assert.equal((await publishAction(flow.id)).status, 200)
      stored = await row(flow.id, seeded.organizationId)
      assert.equal(stored.trigger.type, 'schedule', 'publish is what arms the new trigger')
      assert.equal(typeof stored.trigger.schedule.anchor, 'string', 'and anchors its schedule')
      assert.equal(stored.trigger.webhookSecretHash, 'live-hash', 'the secret is kept for a switch back')
    })
  })

  test('a draft-only flow still syncs its trigger columns on save', async () => {
    await withOrg(async (seeded) => {
      const flow = await mkFlow(seeded, { type: 'manual' })
      assert.equal((await put({ id: flow.id, graph: graphWith({ type: 'activity', source: 'github', kinds: ['pr.opened'] }) })).status, 200)
      const stored = await row(flow.id, seeded.organizationId)
      assert.equal(stored.trigger.type, 'activity')
      assert.equal(stored.activitySource, 'github')
      assert.deepEqual(stored.activityKinds, ['pr.opened'])
    })
  })

  test('the poll cursor survives draft edits of a published poll, and resets when a new read is published', async () => {
    await withOrg(async (seeded) => {
      const flow = await mkFlow(seeded, poll())
      assert.equal((await publishAction(flow.id)).status, 200)
      const cursor = { seen: ['a', 'b'], lastPolledAt: new Date().toISOString() }
      await prisma.flow.update({ where: { id: flow.id, organizationId: seeded.organizationId }, data: { pollCursor: cursor } })

      // Draft changes the read: nothing fires differently yet, cursor kept.
      assert.equal((await put({ id: flow.id, graph: graphWith(poll({ dedupeKey: 'name' })) })).status, 200)
      assert.deepEqual((await row(flow.id, seeded.organizationId)).pollCursor, cursor)

      // Publishing that new read baselines instead of starting a run per record.
      assert.equal((await publishAction(flow.id)).status, 200)
      assert.equal((await row(flow.id, seeded.organizationId)).pollCursor, null)

      // A republish that keeps the read keeps the cursor.
      await prisma.flow.update({ where: { id: flow.id, organizationId: seeded.organizationId }, data: { pollCursor: cursor } })
      assert.equal((await put({ id: flow.id, graph: { ...graphWith(poll({ dedupeKey: 'name', emit: 'batch' })) } })).status, 200)
      assert.equal((await publishAction(flow.id)).status, 200)
      assert.deepEqual((await row(flow.id, seeded.organizationId)).pollCursor, cursor)
    })
  })

  test('publish refuses a poll on a write tool, bad inputs, or a missing connection', async () => {
    await withOrg(async (seeded) => {
      const writer = await mkFlow(seeded, poll({ toolName: 'data_table_create_table' }))
      const refused = await publishAction(writer.id)
      assert.equal(refused.status, 400)
      assert.match((await refused.json()).error, /can only read/)

      const badArgs = await mkFlow(seeded, poll({ toolName: 'data_table_get_rows', args: '[1]' }))
      const refusedArgs = await publishAction(badArgs.id)
      assert.equal(refusedArgs.status, 400)
      assert.match((await refusedArgs.json()).error, /JSON object/)

      const unknown = await mkFlow(seeded, poll({ connectionId: 'no-such-connection' }))
      assert.equal((await publishAction(unknown.id)).status, 400)
    })
  })

  test('revert re-states the published trigger, healing a row a draft save rewrote', async () => {
    await withOrg(async (seeded) => {
      const flow = await mkFlow(seeded, { type: 'webhook', webhookSecretHash: 'live-hash' })
      assert.equal((await publishAction(flow.id)).status, 200)
      assert.equal((await put({ id: flow.id, graph: graphWith(schedule) })).status, 200)
      // What a draft save wrote before this rule existed.
      await prisma.flow.update({
        where: { id: flow.id, organizationId: seeded.organizationId },
        data: { trigger: { ...schedule, webhookSecretHash: 'live-hash' } },
      })

      assert.equal((await publishAction(flow.id, { revert: true })).status, 200)
      const stored = await row(flow.id, seeded.organizationId)
      assert.equal(stored.graph.nodes[0].data.trigger.type, 'webhook', 'draft is back on the published graph')
      assert.equal(stored.trigger.type, 'webhook', 'and so is the live trigger')
      assert.equal(stored.trigger.webhookSecretHash, 'live-hash')
    })
  })

  test('a version restore re-syncs the trigger of an unpublished flow and leaves a published one live', async () => {
    await withOrg(async (seeded) => {
      const flow = await mkFlow(seeded, { type: 'webhook', webhookSecretHash: 'live-hash' })
      assert.equal((await publishAction(flow.id)).status, 200) // v1: webhook
      assert.equal((await put({ id: flow.id, graph: graphWith(schedule) })).status, 200)

      // Published: the restore rewrites the draft only.
      await prisma.flow.update({ where: { id: flow.id, organizationId: seeded.organizationId }, data: { trigger: { type: 'webhook', webhookSecretHash: 'live-hash' } } })
      assert.equal((await put({ id: flow.id, graph: graphWith({ type: 'manual' }) })).status, 200)
      assert.equal((await restore(flow.id, 1)).status, 200)
      assert.equal((await row(flow.id, seeded.organizationId)).trigger.type, 'webhook')

      // Unpublished: the columns follow the draft, through unpublish and restore.
      assert.equal((await put({ id: flow.id, graph: graphWith({ type: 'manual' }) })).status, 200)
      assert.equal((await publishAction(flow.id, { unpublish: true })).status, 200)
      let stored = await row(flow.id, seeded.organizationId)
      assert.equal(stored.trigger.type, 'manual', 'unpublish hands the columns back to the draft')
      assert.equal((await restore(flow.id, 1)).status, 200)
      stored = await row(flow.id, seeded.organizationId)
      assert.equal(stored.trigger.type, 'webhook', 'the restored webhook draft is what publishing will arm')
      assert.equal(stored.trigger.webhookSecretHash, 'live-hash')
    })
  })

  test('minting a secret for a published flow’s webhook draft does not re-arm the live trigger', async () => {
    await withOrg(async (seeded) => {
      const flow = await mkFlow(seeded, schedule)
      assert.equal((await publishAction(flow.id)).status, 200)
      assert.equal((await put({ id: flow.id, graph: graphWith({ type: 'webhook' }) })).status, 200)
      assert.equal((await mint(flow.id)).status, 200)
      const stored = await row(flow.id, seeded.organizationId)
      assert.equal(stored.trigger.type, 'schedule', 'the published schedule keeps running')
      assert.equal(typeof stored.trigger.webhookSecretHash, 'string', 'the secret is stored for the publish')

      assert.equal((await publishAction(flow.id)).status, 200, 'a webhook publish finds its secret')
      const armed = await row(flow.id, seeded.organizationId)
      assert.equal(armed.trigger.type, 'webhook')
      assert.equal(armed.trigger.webhookSecretHash, stored.trigger.webhookSecretHash)
    })
  })

  test('the public API PUT keeps the webhook secret and schedule anchor, and leaves a published trigger live', async () => {
    await withOrg(async (seeded) => {
      const key = `bsk_${randomBytes(32).toString('hex')}`
      await prisma.apiKey.create({
        data: {
          name: 'g2 key',
          keyHash: hashToken(key),
          prefix: key.slice(0, 12),
          scopes: ['flows:read', 'flows:write'],
          organizationId: seeded.organizationId,
          userId: seeded.userId,
        },
      })
      const apiPut = (id: string, trigger: Record<string, unknown>) =>
        v1Route.PUT(new Request(`http://test/api/v1/flows/${id}`, {
          method: 'PUT',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ format: 'backstory.flow.v1', flow: { name: 'Via API', graph: graphWith(trigger) } }),
        }))

      const anchor = '2026-01-01T00:00:00.000Z'
      const draft = await mkFlow(seeded, { ...schedule, schedule: { ...schedule.schedule, anchor }, webhookSecretHash: 'kept' })
      assert.equal((await apiPut(draft.id, schedule)).status, 200)
      let stored = await row(draft.id, seeded.organizationId)
      assert.equal(stored.trigger.webhookSecretHash, 'kept', 'a package never carries the hash; the row keeps it')
      assert.equal(stored.trigger.schedule.anchor, anchor, 'an unchanged schedule keeps its anchor')

      const live = await mkFlow(seeded, { type: 'webhook', webhookSecretHash: 'live' })
      assert.equal((await publishAction(live.id)).status, 200)
      assert.equal((await apiPut(live.id, schedule)).status, 200)
      stored = await row(live.id, seeded.organizationId)
      assert.equal(stored.trigger.type, 'webhook', 'the API edits the draft; publish arms it')
      assert.equal(stored.graph.nodes[0].data.trigger.type, 'schedule')
    })
  })
}

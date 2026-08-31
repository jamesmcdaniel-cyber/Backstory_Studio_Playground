import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Resolution when the mirror does not yet know about a live Nango connection.
 *
 * The mirror is only our COPY of Nango's connections, refreshed on an
 * integrations page view or a webhook. Neither is guaranteed: a rebuilt Nango
 * environment starts with an empty mirror, and the webhook needs a signing key
 * a deployment may not have set. Until one of them happens, Nango holds a
 * perfectly good connection while every tool call reports "connect your
 * account" to someone who just connected it — which is how a freshly connected
 * GitHub could not be synced.
 *
 * Resolution now reconciles once on a miss, rate-limited per org.
 */

const TEST_DB = process.env.TEST_DATABASE_URL
const ENABLED = Boolean(TEST_DB)

if (!ENABLED) {
  test('cold-mirror connection resolution (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}

if (ENABLED) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.NANGO_API_KEY = 'test-nango-api-key'

  let prisma: any
  let seedTestOrg: any
  let resolveNangoConnection: any
  let stubServer: http.Server

  /** What the stubbed Nango returns, and how many times it was asked. */
  let listed: unknown[] = []
  let listCalls = 0
  let failNext = false

  before(async () => {
    stubServer = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      res.setHeader('content-type', 'application/json')
      if (url.pathname === '/connections') {
        listCalls += 1
        if (failNext) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: 'nango is down' }))
          return
        }
        res.statusCode = 200
        res.end(JSON.stringify({ connections: listed }))
        return
      }
      res.statusCode = 404
      res.end(JSON.stringify({ error: 'not_found' }))
    })
    await new Promise<void>((resolve) => stubServer.listen(0, '127.0.0.1', resolve))
    process.env.NANGO_HOST = `http://127.0.0.1:${(stubServer.address() as AddressInfo).port}`
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg } = await import('@/lib/server/__tests__/test-auth'))
    ;({ resolveNangoConnection } = await import('../delivery'))
  })

  after(async () => {
    await new Promise<void>((resolve) => stubServer.close(() => resolve()))
  })

  const liveConnection = (organizationId: string, connectionId: string, key: string) => ({
    connection_id: connectionId,
    provider_config_key: key,
    provider: key,
    created: new Date().toISOString(),
    errors: [],
    tags: { org_id: organizationId },
  })

  test('a connection Nango has but the mirror does not still resolves', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const id = `gh-${s.organizationId}`
      // Exactly the reported state: GitHub connected in Nango, mirror empty.
      listed = [liveConnection(s.organizationId, id, 'github')]
      assert.equal(await prisma.nangoConnection.count({ where: { organizationId: s.organizationId } }), 0)

      const resolved = await resolveNangoConnection(s.organizationId, ['github'], s.userId)
      assert.ok(resolved, 'resolves without waiting for a page view or a webhook')
      assert.equal(resolved.connectionId, id)

      // And the reconciliation persisted, so the next call is a plain mirror read.
      assert.equal(await prisma.nangoConnection.count({ where: { organizationId: s.organizationId } }), 1)
    } finally {
      await s.cleanup()
    }
  })

  test('a genuine "not connected" does not hit Nango on every call', async () => {
    const s = await seedTestOrg(prisma)
    try {
      listed = []
      const before = listCalls
      assert.equal(await resolveNangoConnection(s.organizationId, ['github'], s.userId), null)
      const afterFirst = listCalls
      assert.equal(afterFirst, before + 1, 'the first miss reconciles once')

      // Repeated misses inside the window must stay local: this is the common
      // case (a provider the workspace never connected) and it is on the path
      // of every tool call.
      for (let i = 0; i < 3; i += 1) {
        assert.equal(await resolveNangoConnection(s.organizationId, ['github'], s.userId), null)
      }
      assert.equal(listCalls, afterFirst, 'later misses are rate-limited')
    } finally {
      await s.cleanup()
    }
  })

  test('a Nango outage degrades to the mirror instead of throwing', async () => {
    const s = await seedTestOrg(prisma)
    try {
      failNext = true
      // Resolution sits under every tool call; a Nango hiccup must not turn a
      // "no connection" into a crashed run.
      const resolved = await resolveNangoConnection(s.organizationId, ['github'], s.userId)
      assert.equal(resolved, null)
    } finally {
      failNext = false
      await s.cleanup()
    }
  })

  test('an existing mirror hit never reconciles at all', async () => {
    const s = await seedTestOrg(prisma)
    try {
      await prisma.nangoConnection.create({
        data: {
          organizationId: s.organizationId,
          userId: s.userId,
          connectionId: `warm-${s.organizationId}`,
          providerConfigKey: 'github',
          provider: 'github',
          status: 'connected',
        },
      })
      const before = listCalls
      const resolved = await resolveNangoConnection(s.organizationId, ['github'], s.userId)
      assert.ok(resolved)
      assert.equal(listCalls, before, 'the warm path stays a single local query')
    } finally {
      await s.cleanup()
    }
  })
}

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * What the mirror does when Nango reports NO connections for an org.
 *
 * This is the shape a rebuilt/emptied Nango environment takes (the account is
 * re-created under a new secret key and every connection is gone). Deleting the
 * mirror on an empty snapshot is unsafe — a transient empty listing would
 * disconnect a healthy workspace — but leaving the rows `connected` splits the
 * two readers apart: the integrations page renders the LIVE listing and
 * correctly shows nothing connected, while the agent runtime reads the MIRROR
 * and keeps handing agents connection ids that no longer exist, so tool calls
 * fail deep in the provider proxy instead of saying "connect your account".
 *
 * So an empty snapshot DEMOTES rather than deletes, and a later non-empty one
 * heals it. Run against a real Postgres via TEST_DATABASE_URL.
 */

const TEST_DB = process.env.TEST_DATABASE_URL
const ENABLED = Boolean(TEST_DB)

if (!ENABLED) {
  test('nango mirror empty-snapshot demotion (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}

if (ENABLED) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.NANGO_SECRET_KEY = 'test-nango-secret'

  let prisma: any
  let seedTestOrg: any
  let syncOrgNangoConnections: any
  let resolveNangoConnection: any
  let stubServer: http.Server

  // What the stubbed GET /connections returns for this run.
  let listed: unknown[] = []

  before(async () => {
    stubServer = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      res.setHeader('content-type', 'application/json')
      if (url.pathname === '/connections') {
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
    ;({ syncOrgNangoConnections } = await import('../mirror'))
    ;({ resolveNangoConnection } = await import('../delivery'))
  })

  after(async () => {
    await new Promise<void>((resolve) => stubServer.close(() => resolve()))
  })

  const nangoConnection = (organizationId: string, connectionId: string, key: string) => ({
    connection_id: connectionId,
    provider_config_key: key,
    provider: key,
    created: new Date().toISOString(),
    errors: [],
    tags: { org_id: organizationId },
  })

  const mirrorRow = (organizationId: string, connectionId: string, key: string) =>
    prisma.nangoConnection.create({
      data: { organizationId, connectionId, providerConfigKey: key, provider: key, status: 'connected' },
    })

  const rows = (organizationId: string) =>
    prisma.nangoConnection.findMany({ where: { organizationId }, orderBy: { connectionId: 'asc' } })

  test('an empty snapshot demotes the mirror instead of leaving it connected', async () => {
    const s = await seedTestOrg(prisma)
    try {
      await mirrorRow(s.organizationId, `dead-slack-${s.organizationId}`, 'slack')
      // The wiped account: the listing succeeds and returns nothing.
      listed = []

      const status = await syncOrgNangoConnections(s.organizationId)
      assert.deepEqual(status, {}, 'the page sees nothing connected')

      const after = await rows(s.organizationId)
      assert.equal(after.length, 1, 'the row is kept, not deleted — a transient empty must not wipe a workspace')
      assert.equal(after[0].status, 'error')
      assert.match(after[0].lastError, /[Rr]econnect/)

      // The point of the demotion: the runtime now agrees with the page.
      assert.equal(
        await resolveNangoConnection(s.organizationId, ['slack'], s.userId),
        null,
        'a dead connection id is no longer handed to agents',
      )
    } finally {
      await s.cleanup()
    }
  })

  test('a later non-empty snapshot heals the demoted rows', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const id = `slack-${s.organizationId}`
      await mirrorRow(s.organizationId, id, 'slack')

      listed = []
      await syncOrgNangoConnections(s.organizationId)
      assert.equal((await rows(s.organizationId))[0].status, 'error')

      // Nango answers properly again (or the user reconnected).
      listed = [nangoConnection(s.organizationId, id, 'slack')]
      await syncOrgNangoConnections(s.organizationId)

      const healed = await rows(s.organizationId)
      assert.equal(healed.length, 1)
      assert.equal(healed[0].status, 'connected', 'demotion is self-healing, not a dead end')
      assert.equal(healed[0].lastError, null)
      assert.ok(await resolveNangoConnection(s.organizationId, ['slack'], s.userId))
    } finally {
      await s.cleanup()
    }
  })

  test('a non-empty snapshot still deletes the connections it no longer lists', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const kept = `keep-${s.organizationId}`
      await mirrorRow(s.organizationId, kept, 'slack')
      await mirrorRow(s.organizationId, `gone-${s.organizationId}`, 'github')

      listed = [nangoConnection(s.organizationId, kept, 'slack')]
      await syncOrgNangoConnections(s.organizationId)

      const after = await rows(s.organizationId)
      assert.equal(after.length, 1, 'the unlisted connection is reconciled away as before')
      assert.equal(after[0].connectionId, kept)
      assert.equal(after[0].status, 'connected')
    } finally {
      await s.cleanup()
    }
  })
}

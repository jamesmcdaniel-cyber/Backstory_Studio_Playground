import { test, before } from 'node:test'
import assert from 'node:assert/strict'

/**
 * The picker and the runtime must agree on what "connected" means.
 *
 * The integration picker calls a connection connected after normalizing its
 * providerConfigKey through fromNangoProviderKey, which accepts variant Nango
 * integration ids ('slack-prod' is asserted in registry.test.ts). Resolution
 * matched an exact allowlist instead, so an org whose Nango integration id was
 * spelled differently saw a green Gmail chip in agent config and got zero tools
 * at run time — the agent then reported having nothing connected.
 */

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seedTestOrg: any
  let resolveDeliveryConnection: any
  let resolveNangoConnection: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg } = await import('@/lib/server/__tests__/test-auth'))
    ;({ resolveDeliveryConnection, resolveNangoConnection } = await import('../delivery'))
  })

  const connect = (organizationId: string, providerConfigKey: string, userId?: string | null) =>
    prisma.nangoConnection.create({
      data: {
        organizationId,
        userId: userId ?? null,
        connectionId: `conn-${providerConfigKey}-${userId ?? 'org'}`,
        providerConfigKey,
        status: 'connected',
      },
    })

  test('a variant Gmail integration id still resolves — the picker calls it connected', async () => {
    const s = await seedTestOrg(prisma)
    try {
      // Not the canonical 'google-mail'; the picker shows this as Gmail.
      await connect(s.organizationId, 'google-mail-v2')
      const resolved = await resolveDeliveryConnection(s.organizationId, 'gmail', s.userId)
      assert.ok(resolved, 'Gmail resolves from a variant provider config key')
      assert.equal(resolved.providerConfigKey, 'google-mail-v2')
    } finally {
      await s.cleanup()
    }
  })

  test('exact provider keys keep resolving, and are preferred over variants', async () => {
    const s = await seedTestOrg(prisma)
    try {
      await connect(s.organizationId, 'google-mail-v2')
      await connect(s.organizationId, 'google-mail')
      const resolved = await resolveDeliveryConnection(s.organizationId, 'gmail', s.userId)
      assert.equal(resolved.providerConfigKey, 'google-mail', 'an exact match wins over the canonical fallback')
    } finally {
      await s.cleanup()
    }
  })

  test('the acting user own connection still wins over an org connection', async () => {
    const s = await seedTestOrg(prisma)
    try {
      await connect(s.organizationId, 'slack-prod', null)
      await connect(s.organizationId, 'slack-prod', s.userId)
      const resolved = await resolveDeliveryConnection(s.organizationId, 'slack', s.userId)
      assert.equal(resolved.scope, 'user', 'delivery still goes out as the rep, not the org')
    } finally {
      await s.cleanup()
    }
  })

  test('a different provider is never borrowed to satisfy a capability', async () => {
    const s = await seedTestOrg(prisma)
    try {
      // 'outlook-mail' used to normalize to Gmail (any *mail* key did), which
      // would have handed an Outlook connection to the Gmail adapter.
      await connect(s.organizationId, 'outlook-mail')
      await connect(s.organizationId, 'hubspot')
      assert.equal(await resolveDeliveryConnection(s.organizationId, 'gmail', s.userId), null)
      assert.equal(await resolveNangoConnection(s.organizationId, ['github'], s.userId), null)
    } finally {
      await s.cleanup()
    }
  })

  test('another org connection is never resolved', async () => {
    const owner = await seedTestOrg(prisma)
    const other = await seedTestOrg(prisma)
    try {
      await connect(owner.organizationId, 'google-mail')
      assert.equal(await resolveDeliveryConnection(other.organizationId, 'gmail', other.userId), null)
    } finally {
      await owner.cleanup()
      await other.cleanup()
    }
  })

  test('a disconnected row does not count as connected', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const row = await connect(s.organizationId, 'google-mail')
      await prisma.nangoConnection.update({
        where: { id: row.id, organizationId: s.organizationId },
        data: { status: 'error' },
      })
      assert.equal(await resolveDeliveryConnection(s.organizationId, 'gmail', s.userId), null)
    } finally {
      await s.cleanup()
    }
  })
}

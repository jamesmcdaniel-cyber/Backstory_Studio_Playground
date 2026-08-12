import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

/**
 * The invariant: a deactivated owner's credentials are unresolvable through the
 * guarded client, and still visible through systemPrisma so the sweeper can
 * clean them up.
 */

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let systemPrisma: any
  let seedTestOrg: any

  before(async () => {
    ;({ prisma, systemPrisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg } = await import('@/lib/server/__tests__/test-auth'))
  })

  /** A second member in the same org, deactivated, holding one of each credential. */
  async function seedSuspendedOwner(organizationId: string) {
    const user = await systemPrisma.user.create({
      data: {
        supabaseId: crypto.randomUUID(),
        email: `suspended-${crypto.randomUUID()}@example.com`,
        organizationId,
        isActive: false,
      },
    })
    await systemPrisma.integration.create({
      data: { organizationId, userId: user.id, provider: 'slack' },
    })
    await systemPrisma.mcpConnection.create({
      data: { organizationId, userId: user.id, name: 'personal', serverUrl: 'https://example.com/mcp' },
    })
    await systemPrisma.nangoConnection.create({
      data: {
        organizationId,
        userId: user.id,
        connectionId: `conn-${user.id}`,
        providerConfigKey: 'slack',
        status: 'connected',
      },
    })
    return user
  }

  test('a suspended owner’s credentials are invisible through the guarded client', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const suspended = await seedSuspendedOwner(s.organizationId)

      const [integrations, mcp, nango] = await Promise.all([
        prisma.integration.findMany({ where: { organizationId: s.organizationId } }),
        prisma.mcpConnection.findMany({ where: { organizationId: s.organizationId } }),
        prisma.nangoConnection.findMany({ where: { organizationId: s.organizationId } }),
      ])

      assert.equal(integrations.some((r: any) => r.userId === suspended.id), false, 'Integration must be filtered')
      assert.equal(mcp.some((r: any) => r.userId === suspended.id), false, 'McpConnection must be filtered')
      assert.equal(nango.some((r: any) => r.userId === suspended.id), false, 'NangoConnection must be filtered')
    } finally {
      await s.cleanup()
    }
  })

  test('a suspended owner’s Nango connection is not resolvable for delivery', async () => {
    // The end-to-end point of the invariant: not merely absent from a list, but
    // unusable by the runtime that would post as them.
    const s = await seedTestOrg(prisma)
    try {
      const suspended = await seedSuspendedOwner(s.organizationId)
      const { resolveNangoConnection } = await import('@/lib/nango/delivery')

      const resolved = await resolveNangoConnection(s.organizationId, ['slack'], suspended.id)

      assert.equal(resolved, null, 'a suspended person’s token must not execute anything')
    } finally {
      await s.cleanup()
    }
  })

  test('the same rows ARE visible through systemPrisma, so the sweeper can clean them', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const suspended = await seedSuspendedOwner(s.organizationId)

      const rows = await systemPrisma.integration.findMany({ where: { organizationId: s.organizationId } })

      assert.equal(rows.some((r: any) => r.userId === suspended.id), true)
    } finally {
      await s.cleanup()
    }
  })

  test('an ACTIVE member’s own credentials stay resolvable', async () => {
    // The guard must not break the ordinary case.
    const s = await seedTestOrg(prisma)
    try {
      await systemPrisma.integration.create({
        data: { organizationId: s.organizationId, userId: s.userId, provider: 'slack' },
      })

      const rows = await prisma.integration.findMany({ where: { organizationId: s.organizationId } })

      assert.equal(rows.some((r: any) => r.userId === s.userId), true)
    } finally {
      await s.cleanup()
    }
  })

  test('org-owned rows (userId null) stay resolvable', async () => {
    const s = await seedTestOrg(prisma)
    try {
      await systemPrisma.mcpConnection.create({
        data: { organizationId: s.organizationId, userId: null, name: 'shared', serverUrl: 'https://example.com/mcp' },
      })

      const rows = await prisma.mcpConnection.findMany({ where: { organizationId: s.organizationId } })

      assert.equal(rows.some((r: any) => r.userId === null), true, 'a workspace-owned server belongs to the org')
    } finally {
      await s.cleanup()
    }
  })
}

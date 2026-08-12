import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let systemPrisma: any
  let seedTestOrg: any
  let revokeUserAccess: any

  before(async () => {
    ;({ prisma, systemPrisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg } = await import('@/lib/server/__tests__/test-auth'))
    ;({ revokeUserAccess } = await import('../revoke-user-access'))
  })

  async function seedMemberWithEverything(organizationId: string, isActive = true) {
    const user = await systemPrisma.user.create({
      data: {
        supabaseId: crypto.randomUUID(),
        email: `leaver-${crypto.randomUUID()}@example.com`,
        organizationId,
        isActive,
      },
    })
    await systemPrisma.integration.create({ data: { organizationId, userId: user.id, provider: 'slack' } })
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
    await systemPrisma.apiKey.create({
      data: { organizationId, userId: user.id, name: 'k', keyHash: crypto.randomUUID(), prefix: 'bs_test_1234' },
    })
    const flow = await systemPrisma.flow.create({
      data: { organizationId, userId: user.id, name: 'theirs', status: 'ACTIVE' },
    })
    return { user, flow }
  }

  const revoke = (userId: string, organizationId: string) =>
    systemPrisma.$transaction((tx: any) =>
      revokeUserAccess(tx, { userId, organizationId, reason: 'deactivated' }),
    )

  test('revocation removes every user-owned credential', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const { user } = await seedMemberWithEverything(s.organizationId)

      const result = await revoke(user.id, s.organizationId)

      assert.equal(result.credentials.integration, 1)
      assert.equal(result.credentials.mcpConnection, 1)
      assert.equal(result.credentials.nangoConnection, 1)
      assert.equal(await systemPrisma.integration.count({ where: { userId: user.id } }), 0)
      assert.equal(await systemPrisma.mcpConnection.count({ where: { userId: user.id } }), 0)
      assert.equal(await systemPrisma.nangoConnection.count({ where: { userId: user.id } }), 0)
    } finally {
      await s.cleanup()
    }
  })

  test('revocation works on an ALREADY-deactivated user', async () => {
    // The ordering hazard: once isActive is false, the owner-liveness guard hides
    // these very rows from the guarded client. If revocation read through that
    // client it would silently revoke nothing — worst case, because the caller
    // gets a success with zero counts and the credentials stay live.
    const s = await seedTestOrg(prisma)
    try {
      const { user } = await seedMemberWithEverything(s.organizationId, false)

      const result = await revoke(user.id, s.organizationId)

      assert.equal(result.credentials.integration, 1, 'a suspended user’s credentials must still be revocable')
      assert.equal(result.pendingUpstreamRevokes.length, 1, 'and their upstream grant must still be reported')
    } finally {
      await s.cleanup()
    }
  })

  test('revocation marks their API keys revoked', async () => {
    // They already fail closed at auth, but an un-revoked row makes any
    // credential inventory read wrong.
    const s = await seedTestOrg(prisma)
    try {
      const { user } = await seedMemberWithEverything(s.organizationId)

      await revoke(user.id, s.organizationId)

      assert.equal(await systemPrisma.apiKey.count({ where: { userId: user.id, revokedAt: null } }), 0)
    } finally {
      await s.cleanup()
    }
  })

  test('revocation quarantines their work instead of deleting it', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const { user, flow } = await seedMemberWithEverything(s.organizationId)

      await revoke(user.id, s.organizationId)

      const after = await systemPrisma.flow.findUnique({ where: { id: flow.id } })
      assert.ok(after, 'the flow survives — an admin claims it, it is not destroyed')
      assert.ok(after.quarantinedAt, 'and it is quarantined')
      assert.equal(after.status, 'ACTIVE', 'status is untouched so a claim restores nothing wrongly')
    } finally {
      await s.cleanup()
    }
  })

  test('revocation reports the upstream grants still needing deletion', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const { user } = await seedMemberWithEverything(s.organizationId)

      const result = await revoke(user.id, s.organizationId)

      assert.deepEqual(result.pendingUpstreamRevokes, [
        { connectionId: `conn-${user.id}`, providerConfigKey: 'slack' },
      ])
    } finally {
      await s.cleanup()
    }
  })

  test('org-owned rows are untouched — a workspace does not lose its shared connections', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const { user } = await seedMemberWithEverything(s.organizationId)
      await systemPrisma.mcpConnection.create({
        data: { organizationId: s.organizationId, userId: null, name: 'shared', serverUrl: 'https://example.com/mcp' },
      })

      await revoke(user.id, s.organizationId)

      assert.equal(
        await systemPrisma.mcpConnection.count({ where: { organizationId: s.organizationId, userId: null } }),
        1,
      )
    } finally {
      await s.cleanup()
    }
  })

  test('another member’s credentials are untouched', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const { user } = await seedMemberWithEverything(s.organizationId)
      const bystander = await seedMemberWithEverything(s.organizationId)

      await revoke(user.id, s.organizationId)

      assert.equal(await systemPrisma.integration.count({ where: { userId: bystander.user.id } }), 1)
      assert.equal(await systemPrisma.flow.count({ where: { userId: bystander.user.id, quarantinedAt: null } }), 1)
    } finally {
      await s.cleanup()
    }
  })

  test('revocation is idempotent', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const { user } = await seedMemberWithEverything(s.organizationId)

      await revoke(user.id, s.organizationId)
      const second = await revoke(user.id, s.organizationId)

      assert.equal(second.credentials.integration, 0, 'a re-run revokes nothing and does not throw')
      assert.equal(second.quarantined.flows, 0, 'and does not re-stamp already-quarantined work')
    } finally {
      await s.cleanup()
    }
  })
}

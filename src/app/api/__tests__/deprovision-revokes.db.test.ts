import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

/**
 * Every deprovision path must revoke. This is the regression net for the
 * original bug: org-transfer HAD the revocation logic and deactivation simply
 * never called it.
 */

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let systemPrisma: any
  let seedTestOrg: any
  let deprovisionUser: any

  before(async () => {
    ;({ prisma, systemPrisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg } = await import('@/lib/server/__tests__/test-auth'))
    ;({ deprovisionUser } = await import('@/lib/revoke-user-access'))
  })

  async function seedMember(organizationId: string) {
    const user = await systemPrisma.user.create({
      data: {
        supabaseId: crypto.randomUUID(),
        email: `x-${crypto.randomUUID()}@example.com`,
        organizationId,
      },
    })
    await systemPrisma.integration.create({ data: { organizationId, userId: user.id, provider: 'slack' } })
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

  test('deprovisioning deactivates AND revokes in one transaction', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const user = await seedMember(s.organizationId)

      await deprovisionUser({
        userId: user.id,
        organizationId: s.organizationId,
        reason: 'deactivated',
        actorUserId: s.userId,
      })

      const after = await systemPrisma.user.findUnique({ where: { id: user.id } })
      assert.equal(after.isActive, false)
      assert.equal(await systemPrisma.integration.count({ where: { userId: user.id } }), 0)
    } finally {
      await s.cleanup()
    }
  })

  test('deprovisioning enqueues the upstream revoke in the same transaction', async () => {
    // No window where the local row is gone but nothing remembers to delete the
    // grant at the provider.
    const s = await seedTestOrg(prisma)
    try {
      const user = await seedMember(s.organizationId)

      await deprovisionUser({
        userId: user.id,
        organizationId: s.organizationId,
        reason: 'deactivated',
        actorUserId: s.userId,
      })

      const queued = await systemPrisma.outboxEvent.findMany({
        where: { organizationId: s.organizationId, topic: 'credential.revoke' },
      })
      assert.equal(queued.length, 1)
      assert.equal(queued[0].aggregateId, `conn-${user.id}`)
    } finally {
      await s.cleanup()
    }
  })

  test('deprovisioning writes an audit row — removing someone left no trace before', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const user = await seedMember(s.organizationId)

      await deprovisionUser({
        userId: user.id,
        organizationId: s.organizationId,
        reason: 'member_removed',
        actorUserId: s.userId,
      })

      const events = await systemPrisma.auditEvent.findMany({
        where: { organizationId: s.organizationId, action: 'member.deprovisioned', resourceId: user.id },
      })
      assert.equal(events.length, 1)
      assert.equal((events[0].detail as any).reason, 'member_removed')
    } finally {
      await s.cleanup()
    }
  })

  test('quarantining work writes its own audit row', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const user = await seedMember(s.organizationId)
      await systemPrisma.flow.create({
        data: { organizationId: s.organizationId, userId: user.id, name: 'theirs', status: 'ACTIVE' },
      })

      await deprovisionUser({
        userId: user.id,
        organizationId: s.organizationId,
        reason: 'deactivated',
        actorUserId: s.userId,
      })

      const events = await systemPrisma.auditEvent.findMany({
        where: { organizationId: s.organizationId, action: 'work.quarantined', resourceId: user.id },
      })
      assert.equal(events.length, 1)
      assert.equal((events[0].detail as any).flows, 1)
    } finally {
      await s.cleanup()
    }
  })

  test('deprovisioning someone with nothing to quarantine writes no quarantine row', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const user = await seedMember(s.organizationId)

      await deprovisionUser({
        userId: user.id,
        organizationId: s.organizationId,
        reason: 'deactivated',
        actorUserId: s.userId,
      })

      const events = await systemPrisma.auditEvent.findMany({
        where: { organizationId: s.organizationId, action: 'work.quarantined' },
      })
      assert.equal(events.length, 0, 'an empty quarantine is not an event')
    } finally {
      await s.cleanup()
    }
  })
}

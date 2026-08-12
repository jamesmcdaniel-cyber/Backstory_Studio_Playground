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
  let claimQuarantinedWork: any
  let listQuarantinedWork: any

  before(async () => {
    ;({ prisma, systemPrisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg } = await import('@/lib/server/__tests__/test-auth'))
    ;({ claimQuarantinedWork, listQuarantinedWork } = await import('@/lib/quarantine'))
  })

  const formerOwner = (organizationId: string) =>
    systemPrisma.user.create({
      data: {
        supabaseId: crypto.randomUUID(),
        email: `gone-${crypto.randomUUID()}@example.com`,
        organizationId,
        isActive: false,
      },
    })

  test('the queue lists quarantined work with its former owner', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const former = await formerOwner(s.organizationId)
      await systemPrisma.flow.create({
        data: {
          organizationId: s.organizationId,
          userId: former.id,
          name: 'orphaned',
          status: 'ACTIVE',
          quarantinedAt: new Date(),
        },
      })

      const queue = await listQuarantinedWork(s.organizationId)

      assert.equal(queue.length, 1)
      assert.equal(queue[0].name, 'orphaned')
      assert.equal(queue[0].formerOwnerEmail, former.email, 'naming who left is the queue’s whole job')
    } finally {
      await s.cleanup()
    }
  })

  test('work that is not quarantined stays out of the queue', async () => {
    const s = await seedTestOrg(prisma)
    try {
      await systemPrisma.flow.create({
        data: { organizationId: s.organizationId, userId: s.userId, name: 'ordinary', status: 'ACTIVE' },
      })

      assert.deepEqual(await listQuarantinedWork(s.organizationId), [])
    } finally {
      await s.cleanup()
    }
  })

  test('claiming rebinds the owner and clears the quarantine, leaving status alone', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const former = await formerOwner(s.organizationId)
      const flow = await systemPrisma.flow.create({
        data: {
          organizationId: s.organizationId,
          userId: former.id,
          name: 'orphaned',
          status: 'DRAFT',
          quarantinedAt: new Date(),
        },
      })

      const claimed = await claimQuarantinedWork({
        organizationId: s.organizationId,
        kind: 'flow',
        id: flow.id,
        claimantUserId: s.userId,
      })

      assert.equal(claimed, true)
      const after = await systemPrisma.flow.findUnique({ where: { id: flow.id } })
      assert.equal(after.userId, s.userId, 'it runs as the claimant now')
      assert.equal(after.quarantinedAt, null)
      assert.equal(after.status, 'DRAFT', 'a quarantined DRAFT must not come back ACTIVE')
    } finally {
      await s.cleanup()
    }
  })

  test('claiming twice is a no-op the second time, with no second audit row', async () => {
    // Two admins racing on the same row is ordinary; recording a second transfer
    // of ownership that never happened is not.
    const s = await seedTestOrg(prisma)
    try {
      const flow = await systemPrisma.flow.create({
        data: {
          organizationId: s.organizationId,
          userId: null,
          name: 'orphaned',
          status: 'ACTIVE',
          quarantinedAt: new Date(),
        },
      })
      const params = { organizationId: s.organizationId, kind: 'flow' as const, id: flow.id, claimantUserId: s.userId }

      assert.equal(await claimQuarantinedWork(params), true)
      assert.equal(await claimQuarantinedWork(params), false)

      const events = await systemPrisma.auditEvent.findMany({
        where: { organizationId: s.organizationId, action: 'work.claimed', resourceId: flow.id },
      })
      assert.equal(events.length, 1)
    } finally {
      await s.cleanup()
    }
  })

  test('a claim cannot reach into another workspace', async () => {
    const owner = await seedTestOrg(prisma)
    const other = await seedTestOrg(prisma)
    try {
      const flow = await systemPrisma.flow.create({
        data: {
          organizationId: owner.organizationId,
          userId: null,
          name: 'theirs',
          status: 'ACTIVE',
          quarantinedAt: new Date(),
        },
      })

      const claimed = await claimQuarantinedWork({
        organizationId: other.organizationId,
        kind: 'flow',
        id: flow.id,
        claimantUserId: other.userId,
      })

      assert.equal(claimed, false)
      const after = await systemPrisma.flow.findUnique({ where: { id: flow.id } })
      assert.ok(after.quarantinedAt, 'still quarantined in its own workspace')
    } finally {
      await owner.cleanup()
      await other.cleanup()
    }
  })
}

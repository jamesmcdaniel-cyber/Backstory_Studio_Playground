import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

// DB-gated: runs only under TEST_DATABASE_URL (CI-mode), like sibling DB tests.
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENTITLEMENT_GATE = 'off'

  let prisma: any
  let seedTestOrg: any
  let installTestAuth: any
  let route: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth'))
    route = await import('../[id]/trigger-secret/route')
  })

  const get = (flowId: string) =>
    route.GET(new NextRequest(new URL(`http://test/api/flows/${flowId}/trigger-secret`)))
  const mint = (flowId: string) =>
    route.POST(new NextRequest(new URL(`http://test/api/flows/${flowId}/trigger-secret`), { method: 'POST', body: JSON.stringify({}) }))
  const mkFlow = (organizationId: string, userId: string) =>
    prisma.flow.create({ data: { organizationId, userId, name: 'Webhook flow', graph: { nodes: [], edges: [] }, status: 'ACTIVE' } })

  test('GET reports hasSecret=false and the trigger URL for a secretless flow', async () => {
    const s = await seedTestOrg(prisma)
    try {
      installTestAuth(s.auth)
      const flow = await mkFlow(s.organizationId, s.userId)
      const res = await get(flow.id)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.hasSecret, false)
      assert.ok(body.url.endsWith(`/api/flows/${flow.id}/trigger`))
      assert.ok(!('secret' in body), 'GET must never carry a secret field')
    } finally {
      await s.cleanup()
      await prisma.organization.delete({ where: { id: s.organizationId } }).catch(() => {})
    }
  })

  test('GET reports hasSecret=true after mint, still without a secret; POST no longer rewrites trigger.type on re-query', async () => {
    const s = await seedTestOrg(prisma)
    try {
      installTestAuth(s.auth)
      const flow = await mkFlow(s.organizationId, s.userId)
      const minted = await mint(flow.id)
      assert.equal(minted.status, 200)
      const mintedBody = await minted.json()
      assert.ok(mintedBody.updatedAt, 'the builder needs the new optimistic-lock timestamp')
      const res = await get(flow.id)
      const body = await res.json()
      assert.equal(body.hasSecret, true)
      assert.ok(!('secret' in body))
      // Re-query mint path (hasSecret && !rotate) must not write the row:
      // wipe type, call POST non-rotate, type stays absent (save/publish own it).
      const row = await prisma.flow.findFirst({ where: { id: flow.id, organizationId: s.organizationId } })
      const { type: _drop, ...rest } = row.trigger as Record<string, unknown>
      await prisma.flow.update({ where: { id: flow.id, organizationId: s.organizationId }, data: { trigger: rest } })
      await mint(flow.id)
      const after = await prisma.flow.findFirst({ where: { id: flow.id, organizationId: s.organizationId } })
      assert.equal((after.trigger as Record<string, unknown>).type, undefined, 'non-rotate POST is read-only on the row')
    } finally {
      await s.cleanup()
      await prisma.organization.delete({ where: { id: s.organizationId } }).catch(() => {})
    }
  })

  test('cross-org GET → 404', async () => {
    const owner = await seedTestOrg(prisma)
    const other = await seedTestOrg(prisma)
    try {
      installTestAuth(owner.auth)
      const flow = await mkFlow(owner.organizationId, owner.userId)
      installTestAuth(other.auth)
      assert.equal((await get(flow.id)).status, 404)
    } finally {
      await owner.cleanup(); await other.cleanup()
      await prisma.organization.delete({ where: { id: owner.organizationId } }).catch(() => {})
      await prisma.organization.delete({ where: { id: other.organizationId } }).catch(() => {})
    }
  })
}

import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

// End-to-end persistence contract for the builder's settings + History panel.
// DB-gated like the other flow route tests; CI supplies TEST_DATABASE_URL.
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENTITLEMENT_GATE = 'off'

  let prisma: any
  let seedTestOrg: any
  let installTestAuth: any
  let flowsRoute: any
  let publishRoute: any
  let versionsRoute: any

  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'done', type: 'stop', data: { reason: 'complete' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'done' }],
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth'))
    flowsRoute = await import('../route')
    publishRoute = await import('../[id]/publish/route')
    versionsRoute = await import('../[id]/versions/route')
  })

  test('flow details persist, appear in edit history, and publishing captures a restorable version', async () => {
    const seeded = await seedTestOrg(prisma)
    try {
      installTestAuth(seeded.auth)
      const flow = await prisma.flow.create({
        data: {
          organizationId: seeded.organizationId,
          userId: seeded.userId,
          name: 'Before',
          graph,
          trigger: { type: 'manual' },
        },
      })

      const save = await flowsRoute.PUT(new NextRequest(new URL('http://test/api/flows'), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: flow.id,
          name: 'After',
          description: 'Saved from flow settings',
          folder: 'Parity audits',
          visibility: 'private',
        }),
      }))
      assert.equal(save.status, 200)
      const stored = await prisma.flow.findFirst({ where: { id: flow.id, organizationId: seeded.organizationId } })
      assert.equal(stored.name, 'After')
      assert.equal(stored.description, 'Saved from flow settings')
      assert.equal(stored.folder, 'Parity audits')
      assert.equal(stored.visibility, 'private')

      const publish = await publishRoute.POST(new NextRequest(new URL(`http://test/api/flows/${flow.id}/publish`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }))
      assert.equal(publish.status, 200)

      const history = await versionsRoute.GET(new NextRequest(new URL(`http://test/api/flows/${flow.id}/versions`)))
      assert.equal(history.status, 200)
      const body = await history.json()
      assert.equal(body.versions.length, 1)
      assert.equal(body.versions[0].version, 1)
      assert.ok(body.recentEdits.some((edit: any) => {
        const fields = edit.detail?.fields ?? []
        return ['name', 'description', 'folder', 'visibility'].every((field) => fields.includes(field))
      }))
    } finally {
      await seeded.cleanup()
      await prisma.organization.delete({ where: { id: seeded.organizationId } }).catch(() => {})
    }
  })
}

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
  let flowsRoute: any
  let publishRoute: any
  let versionsRoute: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth'))
    flowsRoute = await import('../route')
    publishRoute = await import('../[id]/publish/route')
    versionsRoute = await import('../[id]/versions/route')
  })

  const graphWith = (label: string) => ({
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'note', type: 'note', data: { text: label, color: 'yellow' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'note' }],
  })

  const put = (body: Record<string, unknown>) =>
    flowsRoute.PUT(new NextRequest(new URL('http://test/api/flows'), {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }))
  const publish = (id: string) =>
    publishRoute.POST(new NextRequest(new URL(`http://test/api/flows/${id}/publish`), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }))
  const history = (id: string) => versionsRoute.GET(new NextRequest(new URL(`http://test/api/flows/${id}/versions`)))
  const restore = (id: string, version: number) =>
    versionsRoute.POST(new NextRequest(new URL(`http://test/api/flows/${id}/versions`), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version, action: 'restore' }),
    }))

  test('publishing snapshots each version and a restore is recorded in the edit history', async () => {
    const seeded = await seedTestOrg(prisma)
    try {
      installTestAuth(seeded.auth)
      const flow = await prisma.flow.create({
        data: {
          organizationId: seeded.organizationId,
          userId: seeded.userId,
          name: 'Versioned',
          graph: graphWith('v1'),
          trigger: { type: 'manual' },
        },
      })

      // Publishing must not 500. The snapshot lookup behind the version number
      // was org-unscoped, so the tenant guard rejected EVERY publish — which
      // also meant no flow could be armed for a webhook or schedule.
      const first = await publish(flow.id)
      assert.equal(first.status, 200, 'first publish succeeds')
      assert.equal((await first.json()).flow.version, 1)

      assert.equal((await put({ id: flow.id, graph: graphWith('v2') })).status, 200)
      const second = await publish(flow.id)
      assert.equal(second.status, 200, 'second publish succeeds')
      assert.equal((await second.json()).flow.version, 2, 'version advances off the snapshot history')

      const before = await (await history(flow.id)).json()
      assert.equal(before.versions.length, 2, 'both publishes are snapshotted')

      const restored = await restore(flow.id, 1)
      assert.equal(restored.status, 200)
      const restoredGraph = (await restored.json()).flow.graph
      assert.equal(restoredGraph.nodes.find((n: any) => n.id === 'note').data.text, 'v1', 'draft is back on v1')

      // A restore rewrites the draft exactly as a manual save does; without an
      // audit row the History panel showed the canvas changing with no entry.
      const after = await (await history(flow.id)).json()
      assert.ok(
        after.recentEdits.length > before.recentEdits.length,
        'the restore adds an edit-history entry',
      )
      assert.equal(after.recentEdits[0].detail?.restoredFromVersion, 1, 'and names the version it came from')
    } finally {
      await seeded.cleanup()
      await prisma.organization.delete({ where: { id: seeded.organizationId } }).catch(() => {})
    }
  })
}

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

// DB-gated: runs only under TEST_DATABASE_URL (CI-mode).
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
    route = await import('../import/route')
  })

  const post = (body: unknown) =>
    route.POST(new NextRequest(new URL('http://test/api/flows/import'), { method: 'POST', body: JSON.stringify(body) }))

  test('an n8n workflow JSON imports as a DRAFT flow with a converted graph and warnings', async () => {
    const s = await seedTestOrg(prisma)
    try {
      installTestAuth(s.auth)
      const res = await post({
        name: 'From n8n',
        nodes: [
          { id: 'a', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [0, 0], parameters: {} },
          { id: 'b', name: 'Notify', type: 'n8n-nodes-base.slack', typeVersion: 1, position: [200, 0], parameters: { channel: '#x' } },
        ],
        connections: { Webhook: { main: [[{ node: 'Notify', type: 'main', index: 0 }]] } },
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.ok(body.flow?.id)
      assert.ok(Array.isArray(body.warnings) && body.warnings.length > 0, 'the unconverted Slack step must be warned about')

      const flow = await prisma.flow.findFirst({ where: { id: body.flow.id, organizationId: s.organizationId } })
      assert.equal(flow.status, 'DRAFT')
      const graph = flow.graph as { nodes: { id: string; type: string }[] }
      assert.ok(graph.nodes.some((n) => n.type === 'trigger' && n.id === 'trigger'))
      assert.ok(
        graph.nodes.some(
          (n) => n.type === 'tool' && (n as { data?: { connectionId?: string } }).data?.connectionId === 'nango:slack',
        ),
        'the slack node binds to the platform Slack integration',
      )
      // The import report persists — the toast is a headline, not the only copy.
      const notes = flow.importNotes as {
        notes: { code: string; severity: string; message: string; nodeId?: string }[]
        blocking: number
      }
      assert.ok(notes && Array.isArray(notes.notes) && notes.notes.length > 0, 'import notes persist on the flow')
      assert.equal(typeof notes.blocking, 'number')
      // Typed, node-anchored notes survive the route — not flattened to IMPORT_NOTE.
      const toolNode = graph.nodes.find((n) => n.type === 'tool')!
      assert.ok(
        notes.notes.some((n) => n.nodeId === toolNode.id),
        `expected a note anchored to the imported tool step, got ${JSON.stringify(notes.notes)}`,
      )
      assert.equal(typeof body.blocking, 'number', 'the response carries the blocking count')
    } finally {
      await s.cleanup()
      await prisma.organization.delete({ where: { id: s.organizationId } }).catch(() => {})
    }
  })

  test('a native Backstory package still imports unchanged', async () => {
    const s = await seedTestOrg(prisma)
    try {
      installTestAuth(s.auth)
      const res = await post({
        format: 'backstory.flow.v1',
        flow: {
          name: 'Native',
          graph: {
            nodes: [
              { id: 'trigger', type: 'trigger', data: {} },
              { id: 's1', type: 'transform', data: { fields: [{ name: 'a', value: 'b' }] } },
            ],
            edges: [{ id: 'e1', source: 'trigger', target: 's1' }],
          },
        },
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.ok(body.flow?.id)
    } finally {
      await s.cleanup()
      await prisma.organization.delete({ where: { id: s.organizationId } }).catch(() => {})
    }
  })
}

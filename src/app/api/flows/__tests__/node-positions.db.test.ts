import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

/**
 * A node moved on the canvas must still be there when the user comes back.
 *
 * `position` is optional on every node (absent on pre-canvas flows), so a hop
 * that quietly drops it fails silently: the builder just re-runs dagre and the
 * node snaps back to its computed spot, which reads as "the app forgot". This
 * pins the whole round-trip — save, store, read back, and the layout pass that
 * decides where the node actually renders.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENTITLEMENT_GATE = 'off'

  let prisma: any
  let seedTestOrg: any
  let installTestAuth: any
  let flowsRoute: any
  let flowRoute: any
  let layoutGraph: any
  let setNodePositions: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth'))
    flowsRoute = await import('../route')
    flowRoute = await import('../[id]/route')
    ;({ layoutGraph } = await import('@/lib/flows/layout'))
    ;({ setNodePositions } = await import('@/lib/flows/mutate'))
  })

  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'summarize', type: 'ai', data: { aiOp: 'summarize', input: '{{trigger.input}}' } },
      { id: 'out', type: 'output', data: { outputs: [{ name: 'text', value: '{{step.summarize.output}}', type: 'text' }] } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'summarize' },
      { id: 'e2', source: 'summarize', target: 'out' },
    ],
  }

  const put = (body: Record<string, unknown>) =>
    flowsRoute.PUT(new NextRequest(new URL('http://test/api/flows'), {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }))
  const open = (id: string) => flowRoute.GET(new NextRequest(new URL(`http://test/api/flows/${id}`)))

  test('a dragged node keeps its position across save, reload and re-layout', async () => {
    const seeded = await seedTestOrg(prisma)
    try {
      installTestAuth(seeded.auth)
      const flow = await prisma.flow.create({
        data: { name: 'Positions', organizationId: seeded.organizationId, userId: seeded.userId, graph, trigger: { type: 'manual' } },
      })

      // What the canvas does on drag-stop: stamp every node's current position.
      const moved = setNodePositions(graph, new Map([
        ['trigger', { x: 24, y: 24 }],
        ['summarize', { x: 620, y: 310 }],
        ['out', { x: 980, y: 118 }],
      ]))
      const saved = await put({ id: flow.id, graph: moved })
      assert.equal(saved.status, 200, 'the save is accepted')

      const reopened = await (await open(flow.id)).json()
      const node = reopened.flow.graph.nodes.find((n: any) => n.id === 'summarize')
      assert.deepEqual(node.position, { x: 620, y: 310 }, 'the position survives the round-trip')

      // The layout pass is what decides where it actually renders. A persisted
      // position must win over the dagre placement it would otherwise get.
      const laid = layoutGraph(reopened.flow.graph)
      assert.deepEqual(laid.get('summarize'), { x: 620, y: 310 })
      assert.deepEqual(laid.get('out'), { x: 980, y: 118 })

      // "Tidy up" is the one action allowed to discard a manual arrangement.
      const tidied = layoutGraph(reopened.flow.graph, { force: true })
      assert.notDeepEqual(tidied.get('summarize'), { x: 620, y: 310 })
    } finally {
      await seeded.cleanup()
      await prisma.organization.delete({ where: { id: seeded.organizationId } }).catch(() => {})
    }
  })

  test('moving one node does not disturb the others, and a node with no position still lays out', async () => {
    const seeded = await seedTestOrg(prisma)
    try {
      installTestAuth(seeded.auth)
      const flow = await prisma.flow.create({
        data: { name: 'Partial positions', organizationId: seeded.organizationId, userId: seeded.userId, graph, trigger: { type: 'manual' } },
      })
      const moved = setNodePositions(graph, new Map([['out', { x: 1200, y: 40 }]]))
      assert.equal((await put({ id: flow.id, graph: moved })).status, 200)

      const reopened = await (await open(flow.id)).json()
      const nodes = reopened.flow.graph.nodes
      assert.deepEqual(nodes.find((n: any) => n.id === 'out').position, { x: 1200, y: 40 })
      assert.equal(nodes.find((n: any) => n.id === 'summarize').position, undefined, 'untouched nodes stay unpositioned')

      const laid = layoutGraph(reopened.flow.graph)
      assert.deepEqual(laid.get('out'), { x: 1200, y: 40 }, 'the moved node is honored')
      assert.ok(laid.get('summarize'), 'and the rest still get a computed spot')
    } finally {
      await seeded.cleanup()
      await prisma.organization.delete({ where: { id: seeded.organizationId } }).catch(() => {})
    }
  })
}

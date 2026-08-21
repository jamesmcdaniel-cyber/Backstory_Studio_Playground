import { test, before } from 'node:test'
import assert from 'node:assert/strict'

// DB-gated: runs only under TEST_DATABASE_URL (CI-mode), like sibling DB tests.
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let runFlowExecution: any
  const ids: Record<string, string> = {}

  /** A one-step flow: trigger -> a single code step. */
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: -200, y: 0 }, data: { trigger: { type: 'manual' } } },
      {
        id: 'step',
        type: 'code',
        position: { x: 0, y: 0 },
        data: { label: 'step', language: 'javascript', mode: 'all', code: 'return { value: 1 }' },
      },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'step' }],
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ runFlowExecution } = await import('@/features/flows/execute-flow'))

    const stamp = Date.now()
    const org = await prisma.organization.create({ data: { name: 'Queue Wait', slug: `queue-wait-${stamp}` } })
    ids.org = org.id
    const user = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), email: `queue-wait-${stamp}@example.com`, name: 'Q', organizationId: org.id },
    })
    ids.user = user.id
    const flow = await prisma.flow.create({
      data: { name: 'Queue wait flow', organizationId: org.id, userId: user.id, graph },
    })
    ids.flow = flow.id
  })

  test('an adopted prepared run refreshes startedAt to adoption time, not row-creation time', async () => {
    // Simulate startFlowExecution having created the row well before this
    // process picks it up off the queue — the queue-wait window we must NOT
    // count as execution duration.
    const rowCreatedAt = new Date(Date.now() - 5 * 60_000)
    const run = await prisma.flowRun.create({
      data: {
        flowId: ids.flow,
        organizationId: ids.org,
        userId: ids.user,
        status: 'running',
        input: {},
        graphSnapshot: graph,
        startedAt: rowCreatedAt,
      },
    })

    const adoptionStartedAt = new Date()
    const result = await runFlowExecution({
      flowId: ids.flow,
      organizationId: ids.org,
      userId: ids.user,
      preparedRunId: run.id,
    })
    assert.equal(result.status, 'succeeded')

    const reloaded = await prisma.flowRun.findFirst({ where: { id: run.id, organizationId: ids.org } })
    assert.ok(
      reloaded.startedAt.getTime() >= adoptionStartedAt.getTime(),
      `expected persisted startedAt (${reloaded.startedAt.toISOString()}) >= adoption time (${adoptionStartedAt.toISOString()})`,
    )
    assert.ok(
      reloaded.startedAt.getTime() > rowCreatedAt.getTime(),
      'persisted startedAt must move past the row-creation timestamp, not remain the queue-wait start',
    )
  })
}

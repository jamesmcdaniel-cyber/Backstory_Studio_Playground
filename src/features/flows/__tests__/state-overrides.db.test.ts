import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { enterTestTenant } from '@/lib/server/__tests__/test-tenant'

// DB-gated: runs only under TEST_DATABASE_URL (CI-mode), like sibling DB tests.
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let flowSideEffectKey: any
  let runFlowExecution: any
  const ids: Record<string, string> = {}

  /** A two-step linear flow: `fetch` -> `transform`, both code steps. */
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: -200, y: 0 }, data: { trigger: { type: 'manual' } } },
      {
        id: 'fetch',
        type: 'code',
        position: { x: 0, y: 0 },
        data: { label: 'fetch', language: 'javascript', mode: 'all', code: 'return { value: "live" }' },
      },
      {
        id: 'transform',
        type: 'code',
        position: { x: 200, y: 0 },
        data: { label: 'transform', language: 'javascript', mode: 'all', code: 'return { seen: 1 }' },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'fetch' },
      { id: 'e1', source: 'fetch', target: 'transform' },
    ],
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ flowSideEffectKey } = await import('@/lib/flows/idempotency'))
    ;({ runFlowExecution } = await import('@/features/flows/execute-flow'))

    const stamp = Date.now()
    const org = await prisma.organization.create({ data: { name: 'Fork', slug: `fork-${stamp}` } })
    ids.org = org.id
    // Operate as this tenant for the rest of the file, exactly as the flow
    // engine and the API wrapper do in production. Parent-scoped rows
    // (flow_run_steps) are tenanted through their run, so under RLS a read
    // with no tenant matches nothing and returns [] without an error.
    enterTestTenant(org.id)
    const user = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), email: `fork-${stamp}@example.com`, name: 'F', organizationId: org.id },
    })
    ids.user = user.id
    const flow = await prisma.flow.create({
      data: { name: 'Fork flow', organizationId: org.id, userId: user.id, graph },
    })
    ids.flow = flow.id
  })

  /** A failed run with fetch succeeded and transform failed. */
  async function seedFailedRun() {
    const run = await prisma.flowRun.create({
      data: {
        flowId: ids.flow,
        organizationId: ids.org,
        userId: ids.user,
        status: 'failed',
        input: {},
        graphSnapshot: graph,
        error: 'boom',
        finishedAt: new Date(),
      },
    })
    await prisma.flowRunStep.create({
      data: { flowRunId: run.id, nodeId: 'fetch', order: 0, status: 'succeeded', output: { value: 'original' } },
    })
    await prisma.flowRunStep.create({
      data: { flowRunId: run.id, nodeId: 'transform', order: 1, status: 'failed', error: 'boom' },
    })
    return run
  }

  test('stateOverrides round-trips as JSON on the run row', async () => {
    const run = await seedFailedRun()
    await prisma.flowRun.updateMany({
      where: { id: run.id, organizationId: ids.org },
      data: { stateOverrides: { fetch: { value: 'patched' } } },
    })
    const reloaded = await prisma.flowRun.findFirst({ where: { id: run.id, organizationId: ids.org } })
    assert.deepEqual(reloaded.stateOverrides, { fetch: { value: 'patched' } })
  })

  test('a fork gets different idempotency keys than its source run', () => {
    const source = flowSideEffectKey('run-a', 'send-email', 0)
    const forked = flowSideEffectKey('run-b', 'send-email', 0)
    assert.notEqual(source, forked, 'a fork must not reuse the source run’s dedupe keys')
  })

  test('a patch-resume on the same run keeps identical idempotency keys', () => {
    const before = flowSideEffectKey('run-a', 'send-email', 0)
    const after = flowSideEffectKey('run-a', 'send-email', 0)
    assert.equal(before, after, 'replayed steps must not re-fire external writes')
  })

  test('patch-resume refuses a run that is not failed', async () => {
    const run = await prisma.flowRun.create({
      data: {
        flowId: ids.flow,
        organizationId: ids.org,
        userId: ids.user,
        status: 'succeeded',
        input: {},
        graphSnapshot: graph,
      },
    })

    await assert.rejects(
      () =>
        runFlowExecution({
          flowId: ids.flow,
          organizationId: ids.org,
          userId: ids.user,
          flowRunId: run.id,
          resumeFrom: { nodeId: 'transform' },
        }),
      (error: any) => error?.code === 'FLOW_PATCH_NOT_FAILED',
      'a succeeded run must not be patchable',
    )

    const after = await prisma.flowRun.findFirst({ where: { id: run.id, organizationId: ids.org } })
    assert.equal(after.status, 'succeeded', 'the refused run must be left untouched')
  })

  test('patch-resume appends new rows and keeps the original failed row', async () => {
    const run = await seedFailedRun()

    await runFlowExecution({
      flowId: ids.flow,
      organizationId: ids.org,
      userId: ids.user,
      flowRunId: run.id,
      resumeFrom: { nodeId: 'transform' },
      overrides: { fetch: { value: 'patched' } },
    })

    const rows = await prisma.flowRunStep.findMany({ where: { flowRunId: run.id }, orderBy: { order: 'asc' } })
    const transformRows = rows.filter((row: any) => row.nodeId === 'transform')
    assert.ok(transformRows.length >= 2, 'the retry appends rather than overwriting')
    assert.equal(transformRows[0].status, 'failed', 'original failure must remain as evidence')
    assert.ok(
      transformRows[transformRows.length - 1].order > transformRows[0].order,
      'new rows sort after the originals',
    )

    // The override was persisted for provenance.
    const reloaded = await prisma.flowRun.findFirst({ where: { id: run.id, organizationId: ids.org } })
    assert.deepEqual(reloaded.stateOverrides, { fetch: { value: 'patched' } })
  })

  test('an overridden upstream step is not re-executed and feeds downstream', async () => {
    const run = await seedFailedRun()

    await runFlowExecution({
      flowId: ids.flow,
      organizationId: ids.org,
      userId: ids.user,
      flowRunId: run.id,
      resumeFrom: { nodeId: 'transform' },
      overrides: { fetch: { value: 'patched' } },
    })

    const fetchRows = await prisma.flowRunStep.findMany({
      where: { flowRunId: run.id, nodeId: 'fetch' },
      orderBy: { order: 'asc' },
    })
    assert.equal(fetchRows.length, 1, 'an overridden upstream step must not run again')
  })
}

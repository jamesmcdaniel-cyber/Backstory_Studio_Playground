import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { enterTestTenant } from '@/lib/server/__tests__/test-tenant'

// DB-gated: runs only under TEST_DATABASE_URL (CI-mode), like sibling DB tests.
//
// Before this fix, a pinned/overridden node was seeded straight into
// `completed` and the interpreter's walk never reached it — for an
// adapter-persisted node type (agent/tool/http/ai/subflow/code/knowledge) that
// meant NO FlowRunStep row was ever written for it. A downstream step's input
// then traced back to nothing: the run panel had no row saying "this value
// came from a pin, not a real execution."
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let runFlowExecution: any
  const ids: Record<string, string> = {}

  // trigger -> pinned (code, mocked out) -> consumer (code, reads the pinned output)
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: -200, y: 0 }, data: { trigger: { type: 'manual' } } },
      {
        id: 'pinned',
        type: 'code',
        position: { x: 0, y: 0 },
        data: { label: 'pinned', language: 'javascript', mode: 'all', code: 'return { value: "would call the live API" }' },
      },
      {
        id: 'consumer',
        type: 'code',
        position: { x: 200, y: 0 },
        data: { label: 'consumer', language: 'javascript', mode: 'all', code: 'return { seen: context.steps.pinned.output.value }' },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'pinned' },
      { id: 'e1', source: 'pinned', target: 'consumer' },
    ],
    // n8n-style pinData: `pinned` never actually executes this run.
    pinData: { pinned: { value: 'mocked value' } },
  }

  // Same shape, but `pinned` is an INTERPRETER-NATIVE type (transform) rather
  // than an adapter-persisted one. Those already got a row from interpret.ts's
  // own resume-replay emit before this fix — the gap was that the row carried
  // no log line saying it was a substitution. `consumer` is `code` so it can
  // read `context.steps.pinned.output` to prove it saw the pinned value.
  const interpreterNativeGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: -200, y: 0 }, data: { trigger: { type: 'manual' } } },
      {
        id: 'pinned',
        type: 'transform',
        position: { x: 0, y: 0 },
        data: { label: 'pinned', fields: [{ name: 'value', value: 'would compute from live input' }] },
      },
      {
        id: 'consumer',
        type: 'code',
        position: { x: 200, y: 0 },
        data: { label: 'consumer', language: 'javascript', mode: 'all', code: 'return { seen: context.steps.pinned.output.value }' },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'pinned' },
      { id: 'e1', source: 'pinned', target: 'consumer' },
    ],
    pinData: { pinned: { value: 'mocked value' } },
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ runFlowExecution } = await import('@/features/flows/execute-flow'))

    const stamp = Date.now()
    const org = await prisma.organization.create({ data: { name: 'PinProvenance', slug: `pin-provenance-${stamp}` } })
    ids.org = org.id
    // Operate as this tenant for the rest of the file, exactly as the flow
    // engine and the API wrapper do in production. Parent-scoped rows
    // (flow_run_steps) are tenanted through their run, so under RLS a read
    // with no tenant matches nothing and returns [] without an error.
    enterTestTenant(org.id)
    const user = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), email: `pin-provenance-${stamp}@example.com`, name: 'P', organizationId: org.id },
    })
    ids.user = user.id
    const flow = await prisma.flow.create({
      data: { name: 'Pin provenance flow', organizationId: org.id, userId: user.id, graph },
    })
    ids.flow = flow.id
    const interpreterNativeFlow = await prisma.flow.create({
      data: { name: 'Pin provenance flow (interpreter-native)', organizationId: org.id, userId: user.id, graph: interpreterNativeGraph },
    })
    ids.interpreterNativeFlow = interpreterNativeFlow.id
  })

  after(async () => {
    await prisma.flow.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.delete({ where: { id: ids.org } })
  })

  test('a pinned node leaves a skipped FlowRunStep row with the pin log, and downstream still consumes the pinned value', async () => {
    const result = await runFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.user, input: '' })
    assert.equal(result.status, 'succeeded')

    const steps: any[] = await prisma.flowRunStep.findMany({
      where: { flowRunId: result.flowRunId },
      orderBy: { order: 'asc' },
    })

    const pinnedRow = steps.find((step) => step.nodeId === 'pinned')
    assert.ok(pinnedRow, 'the pinned node must leave a row — previously it left none at all')
    assert.equal(pinnedRow.status, 'skipped', 'reuses the existing skipped status rather than inventing a new one')
    assert.deepEqual(pinnedRow.output, { value: 'mocked value' }, 'the row records what downstream actually consumed')
    assert.ok(Array.isArray(pinnedRow.logs) && pinnedRow.logs.includes('value pinned — node not executed'), 'the log names the substitution')
    assert.equal(pinnedRow.warnings ?? null, null, 'a pin is not a degraded-success warning — it must never flip the run degraded')

    const consumerRow = steps.find((step) => step.nodeId === 'consumer')
    assert.equal(consumerRow.status, 'succeeded')
    assert.deepEqual(consumerRow.output, { seen: 'mocked value' }, 'downstream read the PINNED value, not the live code result')

    const run = await prisma.flowRun.findFirst({ where: { id: result.flowRunId, organizationId: ids.org } })
    assert.equal(run.degraded, false, 'the pinned skip alone must not degrade an otherwise-clean run')

    // Exactly one row for the pinned node — the interpreter's own resume-replay
    // emit for this node type is a no-op (see run-step-persistence.ts), so
    // there is nothing else that could have written a second one.
    assert.equal(steps.filter((step) => step.nodeId === 'pinned').length, 1)
  })

  test('an INTERPRETER-NATIVE pinned node (transform) also carries the pin log on the row interpret.ts writes for it', async () => {
    const result = await runFlowExecution({ flowId: ids.interpreterNativeFlow, organizationId: ids.org, userId: ids.user, input: '' })
    assert.equal(result.status, 'succeeded')

    const steps: any[] = await prisma.flowRunStep.findMany({
      where: { flowRunId: result.flowRunId },
      orderBy: { order: 'asc' },
    })

    const pinnedRow = steps.find((step) => step.nodeId === 'pinned')
    assert.ok(pinnedRow, 'interpret.ts already wrote a row for this type before this fix — it must still be there')
    assert.equal(pinnedRow.status, 'skipped')
    assert.deepEqual(pinnedRow.output, { value: 'mocked value' })
    assert.ok(
      Array.isArray(pinnedRow.logs) && pinnedRow.logs.includes('value pinned — node not executed'),
      'before this fix, interpret.ts\'s own resume-replay emit carried no log at all — this is the gap the finding named',
    )
    assert.equal(pinnedRow.warnings ?? null, null, 'still never a warning — must not flip the run degraded')

    const consumerRow = steps.find((step) => step.nodeId === 'consumer')
    assert.deepEqual(consumerRow.output, { seen: 'mocked value' }, 'downstream still reads the pinned value, unaffected by the log addition')

    // Still exactly one row — the log rides on interpret.ts's existing emit,
    // it does not add a second write path for this node type.
    assert.equal(steps.filter((step) => step.nodeId === 'pinned').length, 1)

    const run = await prisma.flowRun.findFirst({ where: { id: result.flowRunId, organizationId: ids.org } })
    assert.equal(run.degraded, false)
  })
}

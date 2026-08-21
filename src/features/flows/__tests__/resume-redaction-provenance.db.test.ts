import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

// DB-gated: runs only under TEST_DATABASE_URL (CI-mode), like sibling DB tests.
//
// X1 (design spec): run-data-guard.ts appends REDACTED_AT_REST_WARNING to a
// step's persisted `warnings` when it masks that step's stored input/output
// at write time. Before this fix, a resume that replayed such a step from its
// (now-masked) stored output did so silently — the replay carried no signal
// that the value it just handed downstream is not the real one. This proves
// the replayed row now carries a provenance note, via the same
// `completedProvenance` seam Task 11 built for pin/override substitutions
// (see pinned-node-provenance.db.test.ts).
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let runFlowExecution: any
  let REDACTED_AT_REST_WARNING: string
  const ids: Record<string, string> = {}

  // trigger -> compute (interpreter-native transform, succeeds) -> ask (pauses
  // for human review). `compute` is the step whose stored output gets
  // redacted while the run sits waiting, simulating what run-data-guard.ts
  // does at write time for a step it masks.
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: -200, y: 0 }, data: { trigger: { type: 'manual' } } },
      {
        id: 'compute',
        type: 'transform',
        position: { x: 0, y: 0 },
        data: { label: 'compute', fields: [{ name: 'value', value: 'sensitive-computed-value' }] },
      },
      { id: 'ask', type: 'humanReview', position: { x: 200, y: 0 }, data: { message: 'Ship it?' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'compute' },
      { id: 'e1', source: 'compute', target: 'ask' },
    ],
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ runFlowExecution } = await import('@/features/flows/execute-flow'))
    ;({ REDACTED_AT_REST_WARNING } = await import('@/lib/flows/run-data-guard'))

    const stamp = Date.now()
    const org = await prisma.organization.create({ data: { name: 'ResumeRedaction', slug: `resume-redaction-${stamp}` } })
    ids.org = org.id
    const user = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), email: `resume-redaction-${stamp}@example.com`, name: 'R', organizationId: org.id },
    })
    ids.user = user.id
    const flow = await prisma.flow.create({
      data: { name: 'Resume redaction flow', organizationId: org.id, userId: user.id, graph },
    })
    ids.flow = flow.id
  })

  after(async () => {
    await prisma.flow.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.delete({ where: { id: ids.org } })
  })

  test('resuming a run whose prior step output was redacted at rest surfaces a replay warning, not a silent replay', async () => {
    const started = await runFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.user, input: '' })
    assert.equal(started.status, 'waiting')

    const priorSteps: any[] = await prisma.flowRunStep.findMany({ where: { flowRunId: started.flowRunId } })
    const computeRow = priorSteps.find((step) => step.nodeId === 'compute')
    assert.ok(computeRow, 'the compute step must have run and succeeded before the pause')
    assert.equal(computeRow.status, 'succeeded')

    // Simulate what run-data-guard.ts does at write time when it masks a
    // step's stored output: append its marker to warnings and replace the
    // output with a redacted placeholder.
    await prisma.flowRunStep.update({
      where: { id: computeRow.id },
      data: { output: { value: '[redacted]' }, warnings: [REDACTED_AT_REST_WARNING] },
    })

    const done = await runFlowExecution({
      flowId: ids.flow,
      organizationId: ids.org,
      userId: ids.user,
      flowRunId: started.flowRunId,
      reply: 'ship it',
    })
    assert.equal(done.status, 'succeeded')

    const allSteps: any[] = await prisma.flowRunStep.findMany({
      where: { flowRunId: started.flowRunId },
      orderBy: { order: 'asc' },
    })
    const computeRows = allSteps.filter((step) => step.nodeId === 'compute')
    // The resume re-walks the whole graph; `compute` is interpreter-native
    // (transform), so it gets a fresh replay row alongside the original one.
    const replayedRow = computeRows.find((step) =>
      Array.isArray(step.logs) && step.logs.some((log: string) => /redacted stored output/.test(log)),
    )
    assert.ok(
      replayedRow,
      'a step replayed from a redacted stored output must carry a provenance note, not replay silently',
    )
    assert.deepEqual(replayedRow.output, { value: '[redacted]' }, 'the replay still surfaces the (masked) stored value it actually used')
  })
}

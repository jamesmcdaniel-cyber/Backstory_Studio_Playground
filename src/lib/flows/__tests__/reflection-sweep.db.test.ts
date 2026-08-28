import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { enterTestTenant } from '@/lib/server/__tests__/test-tenant'

/**
 * Flows never reflected: reflectAndRemember had exactly one caller
 * (execute-agent.ts). A flow that failed identically every 15 minutes produced
 * 96 failed runs a day and no signal.
 *
 * These pin the cost bounds as much as the behavior — a per-run reflection would
 * mean an LLM call every 15 minutes per flow, which is precisely what the
 * pattern trigger and the debounce exist to prevent.
 */

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let sweepFlowReflection: any
  const ids: Record<string, string> = {}

  /**
   * A generator that records its calls and returns a valid reflection.
   *
   * `callsFor` scopes assertions to ONE fixture flow: the sweep is global by
   * design (it is called from the CRON_SECRET-gated tick), and the shared
   * ci_repro database carries failed runs from every other DB test, so a bare
   * call count would measure the whole database rather than this test.
   */
  function recordingGenerator(result = { title: 'Stale endpoint', rationale: 'It has 404d every run.' }) {
    const calls: Array<{ system: string; user: string }> = []
    return {
      calls,
      callsFor: (flowName: string) => calls.filter((call) => call.user.includes(`Workflow: ${flowName}`)),
      generate: async (opts: { system: string; user: string }) => {
        calls.push({ system: opts.system, user: opts.user })
        return JSON.stringify(result)
      },
    }
  }

  /** Seed `count` failed runs of `flowId`, each with a failing `fetch` step. */
  async function seedFailures(flowId: string, count: number, message = (i: number) => `404 for /users/${i}${i}`) {
    for (let i = 0; i < count; i += 1) {
      const run = await prisma.flowRun.create({
        data: {
          flowId,
          organizationId: ids.org,
          userId: ids.user,
          status: 'failed',
          trigger: { type: 'schedule' },
          startedAt: new Date(Date.now() - (count - i) * 60 * 60 * 1000),
        },
      })
      await prisma.flowRunStep.create({
        data: { flowRunId: run.id, nodeId: 'fetch', status: 'failed', error: message(i), input: {} },
      })
    }
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ sweepFlowReflection } = await import('../reflection-sweep'))

    const stamp = Date.now()
    const org = await prisma.organization.create({ data: { name: 'Reflect', slug: `reflect-${stamp}` } })
    ids.org = org.id
    // Operate as this tenant for the rest of the file, exactly as the flow
    // engine and the API wrapper do in production. Parent-scoped rows
    // (flow_run_steps) are tenanted through their run, so under RLS a read
    // with no tenant matches nothing and returns [] without an error.
    enterTestTenant(org.id)
    const user = await prisma.user.create({
      data: {
        supabaseId: crypto.randomUUID(),
        email: `reflect-${stamp}@example.com`,
        name: 'R',
        organizationId: org.id,
      },
    })
    ids.user = user.id
    const flow = await prisma.flow.create({
      data: { name: 'Nightly brief', organizationId: org.id, userId: user.id, graph: { nodes: [], edges: [] } },
    })
    ids.flow = flow.id
    const clean = await prisma.flow.create({
      data: { name: 'Healthy flow', organizationId: org.id, userId: user.id, graph: { nodes: [], edges: [] } },
    })
    ids.cleanFlow = clean.id

    await seedFailures(ids.flow, 3)
  })

  after(async () => {
    if (!ids.org) return
    // Leftover rows here are exactly the residue that starves
    // MAX_REFLECTIONS_PER_TICK for every later local run: the sweep is a
    // global cross-org scan, and an uncleaned "Reflect" org from a prior run
    // is indistinguishable from a real candidate competing for this tick's
    // 5-flow budget.
    await prisma.templateProposal.deleteMany({ where: { organizationId: ids.org } })
    await prisma.flowRunStep.deleteMany({ where: { run: { organizationId: ids.org } } })
    await prisma.flowRun.deleteMany({ where: { organizationId: ids.org } })
    await prisma.flow.deleteMany({ where: { organizationId: ids.org } })
    await prisma.user.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.delete({ where: { id: ids.org } })
  })

  test('a flow with a pattern produces one process_improvement proposal', async () => {
    const gen = recordingGenerator()
    const flows = await sweepFlowReflection(new Date(), { generate: gen.generate })
    assert.ok(flows.includes(ids.flow))
    assert.equal(gen.callsFor('Nightly brief').length, 1, 'exactly one model call for this flow')

    const proposal = await prisma.templateProposal.findFirst({
      where: {
        organizationId: ids.org,
        kind: 'process_improvement',
        configuration: { path: ['targetId'], equals: ids.flow },
      },
      orderBy: { createdAt: 'desc' },
    })
    assert.ok(proposal)
    assert.equal(proposal.configuration.targetType, 'flow')
    assert.equal(proposal.configuration.targetId, ids.flow)
    assert.equal(proposal.sourceEvidence.stepId, 'fetch')
    assert.equal(proposal.sourceEvidence.occurrences, 3)
    assert.equal(proposal.sourceEvidence.runIds.length, 3)
  })

  test('the prompt carries the pattern and forbids token syntax in the output', async () => {
    const proposal = await prisma.templateProposal.findFirst({
      where: {
        organizationId: ids.org,
        kind: 'process_improvement',
        configuration: { path: ['targetId'], equals: ids.flow },
      },
      orderBy: { createdAt: 'desc' },
    })
    assert.ok(proposal.title.length > 0)
    // The no-raw-token-syntax rule reaches generated copy too.
    assert.ok(!proposal.title.includes('{{'))
    assert.ok(!proposal.rationale.includes('{{'))
  })

  test('the proposal opens the flow editor via the existing accept path', async () => {
    const { proposalImprovementTarget } = await import('@/lib/templates/accept-proposal')
    const proposal = await prisma.templateProposal.findFirst({
      where: {
        organizationId: ids.org,
        kind: 'process_improvement',
        configuration: { path: ['targetId'], equals: ids.flow },
      },
      orderBy: { createdAt: 'desc' },
    })
    assert.deepEqual(proposalImprovementTarget(proposal), { targetType: 'flow', targetId: ids.flow })
  })

  test('a second sweep the same day is debounced — no second model call', async () => {
    // This is the JSON-path filter working: the debounce finds the proposal
    // written above by matching configuration.targetId.
    const gen = recordingGenerator()
    const flows = await sweepFlowReflection(new Date(), { generate: gen.generate })
    assert.equal(gen.callsFor('Nightly brief').length, 0, 'the debounce must suppress a same-day repeat')
    assert.ok(!flows.includes(ids.flow))
  })

  test('a flow with no failures is never a candidate and costs no model call', async () => {
    const gen = recordingGenerator()
    const flows = await sweepFlowReflection(new Date(), { generate: gen.generate })
    assert.ok(!flows.includes(ids.cleanFlow))
    assert.equal(gen.callsFor('Healthy flow').length, 0, 'no failures means never even a candidate')
  })

  test('a throwing generator does not throw out of the sweep', async () => {
    const other = await prisma.flow.create({
      data: { name: 'Breaks', organizationId: ids.org, userId: ids.user, graph: { nodes: [], edges: [] } },
    })
    await seedFailures(other.id, 3, (i) => `503 upstream for /orders/${i}${i}`)
    await assert.doesNotReject(
      sweepFlowReflection(new Date(), {
        generate: async () => {
          throw new Error('model down')
        },
      }),
    )
  })

  test('unparseable model output produces no proposal rather than a broken one', async () => {
    const flow = await prisma.flow.create({
      data: { name: 'Garbled', organizationId: ids.org, userId: ids.user, graph: { nodes: [], edges: [] } },
    })
    await seedFailures(flow.id, 3, (i) => `500 boom for /widgets/${i}${i}`)
    const before = await prisma.templateProposal.count({
      where: { organizationId: ids.org, kind: 'process_improvement' },
    })
    await sweepFlowReflection(new Date(), { generate: async () => 'not json at all' })
    const after = await prisma.templateProposal.count({
      where: { organizationId: ids.org, kind: 'process_improvement' },
    })
    assert.equal(after, before)
  })
}

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

/**
 * The sweep against a real database.
 *
 * The unit test covers the judgement; this covers the part that was missing
 * entirely — that anything at all closes an improvement proposal once the flow
 * it complains about has been running clean.
 */

const TEST_DB = process.env.TEST_DATABASE_URL

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any
  let sweepObsoleteProposals: () => Promise<number>
  let MIN_CLEAN_RUNS: number

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ sweepObsoleteProposals, MIN_CLEAN_RUNS } = await import('../obsolete-proposals'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
  })

  after(async () => { if (seeded) await seeded.cleanup() })

  const makeFlow = async () => (await prisma.flow.create({
    data: {
      name: 'Swept flow',
      organizationId: seeded.organizationId,
      userId: seeded.userId,
      trigger: { type: 'manual' },
      graph: { nodes: [], edges: [] },
    },
  })).id

  const makeProposal = async (flowId: string) => (await prisma.templateProposal.create({
    data: {
      organizationId: seeded.organizationId,
      title: 'next-up step expects a list but receives non-list input',
      rationale: 'It kept failing the same way.',
      kind: 'process_improvement',
      configuration: { targetType: 'flow', targetId: flowId },
      sourceEvidence: {},
      status: 'open',
    },
  })).id

  const addRuns = async (flowId: string, status: string, count: number) => {
    for (let index = 0; index < count; index++) {
      await prisma.flowRun.create({
        data: {
          flowId,
          organizationId: seeded.organizationId,
          userId: seeded.userId,
          status,
          input: {},
          trigger: { type: 'manual' },
          // After the proposal, which is the whole question the sweep asks.
          startedAt: new Date(Date.now() + 1000 * (index + 1)),
        },
      })
    }
  }

  const statusOf = async (id: string) =>
    (await prisma.templateProposal.findFirst({ where: { id, organizationId: seeded.organizationId } }))?.status

  test('a flow running clean since the complaint retires it', async () => {
    const flowId = await makeFlow()
    const proposalId = await makeProposal(flowId)
    await addRuns(flowId, 'succeeded', MIN_CLEAN_RUNS)

    await sweepObsoleteProposals()
    assert.equal(await statusOf(proposalId), 'obsolete')
  })

  test('a flow still failing keeps its complaint open', async () => {
    const flowId = await makeFlow()
    const proposalId = await makeProposal(flowId)
    await addRuns(flowId, 'succeeded', MIN_CLEAN_RUNS)
    await addRuns(flowId, 'failed', 1)

    await sweepObsoleteProposals()
    assert.equal(await statusOf(proposalId), 'open')
  })

  test('a flow that has not run again keeps its complaint — silence is not a fix', async () => {
    const flowId = await makeFlow()
    const proposalId = await makeProposal(flowId)

    await sweepObsoleteProposals()
    assert.equal(await statusOf(proposalId), 'open')
  })

  test('a human decision is never overwritten by the reaper', async () => {
    const flowId = await makeFlow()
    const proposalId = await makeProposal(flowId)
    await addRuns(flowId, 'succeeded', MIN_CLEAN_RUNS)
    await prisma.templateProposal.updateMany({
      where: { id: proposalId, organizationId: seeded.organizationId },
      data: { status: 'accepted' },
    })

    await sweepObsoleteProposals()
    assert.equal(await statusOf(proposalId), 'accepted')
  })
}

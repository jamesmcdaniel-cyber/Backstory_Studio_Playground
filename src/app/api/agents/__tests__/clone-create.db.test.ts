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
  let agentsRoute: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth'))
    agentsRoute = await import('../route')
  })

  const create = (body: Record<string, unknown>) =>
    agentsRoute.POST(new NextRequest(new URL('http://test/api/agents'), { method: 'POST', body: JSON.stringify(body) }))

  /** A fully-configured source agent: tools, skills, model, schedule, delegation. */
  const mkSource = (organizationId: string, userId: string) =>
    prisma.agentTask.create({
      data: {
        type: 'agent',
        agentType: 'CUSTOM',
        priority: 'HIGH',
        description: 'Pipeline research',
        objective: 'Original instructions',
        context: {},
        schedule: { type: 'daily', time: '09:00', timezone: 'UTC', isActive: true },
        status: 'ACTIVE',
        folder: 'Research',
        visibility: 'shared',
        goal: 'Win more deals',
        organizationId,
        userId,
        metadata: {
          title: 'Pipeline researcher',
          description: 'Pipeline research',
          model: 'claude-opus-5',
          integrations: ['salesforce', 'gmail'],
          skills: ['deal-review'],
          icon: '🔎',
          allowSubagents: true,
          subagentIds: ['abc'],
          allowFlows: true,
          flowIds: ['flow-1'],
          autoAnswerFromMemory: true,
          alwaysStrategize: true,
          requireApproval: true,
        },
      },
    })

  test('cloneFrom creates a separate agent that inherits the source tools and overrides only what is sent', async () => {
    const s = await seedTestOrg(prisma)
    try {
      installTestAuth(s.auth)
      const source = await mkSource(s.organizationId, s.userId)
      const body = await (
        await create({
          cloneFrom: source.id,
          title: '2nd Watch demo story lookup',
          description: 'Retrieves the full SalesAI_Demo_Story__c value.',
          instructions: 'Fetch and return the complete field value.',
        })
      ).json()

      assert.ok(body.success, 'create succeeds')
      const created = body.agent
      assert.notEqual(created.id, source.id, 'a SEPARATE agent — the source is not mutated')

      // Overridden by the proposal.
      assert.equal(created.title, '2nd Watch demo story lookup')
      assert.equal(created.instructions, 'Fetch and return the complete field value.')
      assert.equal(created.description, 'Retrieves the full SalesAI_Demo_Story__c value.')

      // Inherited: the tools that let it do the job.
      assert.deepEqual(created.integrations, ['salesforce', 'gmail'], 'connected tools carry over')
      assert.deepEqual(created.skills, ['deal-review'], 'skills carry over')
      assert.equal(created.model, 'claude-opus-5', 'model carries over')
      assert.equal(created.folder, 'Research')
      assert.equal(created.icon, '🔎')
      assert.equal(created.priority, 'high')
      assert.equal(created.allowSubagents, true)
      assert.deepEqual(created.subagentIds, ['abc'])
      assert.equal(created.allowFlows, true)
      assert.deepEqual(created.flowIds, ['flow-1'])
      assert.equal(created.autoAnswerFromMemory, true)
      assert.equal(created.alwaysStrategize, true)
      assert.equal(created.requireApproval, true)

      // NOT inherited: a spun-off agent must not silently double the source's
      // cadence, and it serves a different outcome.
      assert.equal((created.schedule as any).type, 'manual', 'schedule starts manual')
      assert.equal((created.schedule as any).isActive, false)
      assert.equal(created.goal, null, 'goal does not carry over')

      // The source is untouched.
      const after = await prisma.agentTask.findFirst({ where: { id: source.id, organizationId: s.organizationId } })
      assert.equal(after.objective, 'Original instructions', 'the source agent keeps its own instructions')
      assert.equal((after.metadata as any).title, 'Pipeline researcher')
    } finally {
      // cleanup() drops the seeded org (and cascades the agent rows with it).
      await s.cleanup()
    }
  })

  test('cloneFrom falls back to a copy name and cannot reach another org agent', async () => {
    const owner = await seedTestOrg(prisma)
    const other = await seedTestOrg(prisma)
    try {
      installTestAuth(owner.auth)
      const source = await mkSource(owner.organizationId, owner.userId)
      const unnamed = await (await create({ cloneFrom: source.id, instructions: 'Do the other job.' })).json()
      assert.equal(unnamed.agent.title, 'Pipeline researcher (copy)', 'a nameless clone gets a derived title')
      assert.equal(unnamed.agent.instructions, 'Do the other job.')

      // Another tenant cannot clone this agent — 404, not a silent copy.
      installTestAuth(other.auth)
      const response = await create({ cloneFrom: source.id, title: 'Stolen', instructions: 'x' })
      assert.equal(response.status, 404, 'cross-tenant clone is not found')
      const leaked = await prisma.agentTask.count({ where: { organizationId: other.organizationId } })
      assert.equal(leaked, 0, 'nothing was created in the other org')
    } finally {
      await owner.cleanup()
      await other.cleanup()
    }
  })
}

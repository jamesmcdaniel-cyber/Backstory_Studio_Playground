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
  let listRoute: any
  let acceptRoute: any
  let dismissRoute: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth'))
    listRoute = await import('../route')
    acceptRoute = await import('../[id]/accept/route')
    dismissRoute = await import('../[id]/dismiss/route')
  })

  const accept = (id: string) =>
    acceptRoute.POST(new NextRequest(new URL(`http://test/api/template-proposals/${id}/accept`), { method: 'POST' }))
  const dismiss = (id: string) =>
    dismissRoute.POST(new NextRequest(new URL(`http://test/api/template-proposals/${id}/dismiss`), { method: 'POST' }))
  const list = () =>
    listRoute.GET(new NextRequest(new URL('http://test/api/template-proposals')))

  const seed = async () => {
    const s = await seedTestOrg(prisma)
    installTestAuth(s.auth)
    return s
  }

  const mkProposal = (organizationId: string, over: Record<string, unknown> = {}) =>
    prisma.templateProposal.create({
      data: {
        organizationId,
        title: 'Weekly Digest',
        rationale: 'usage shows recurring digests',
        kind: 'agent_template',
        configuration: {
          name: 'Weekly Digest',
          category: 'Sales',
          instructions: 'You build the digest.',
          integrations: ['Slack'],
          exampleOutput: 'A digest.',
          model: 'claude-sonnet-5',
        },
        sourceEvidence: { signal: 'digests' },
        status: 'open',
        ...over,
      },
    })

  test('accept agent_template → ai_generated/org AgentTemplate via createTemplate, createdTemplateId stamped', async () => {
    const s = await seed()
    try {
      const p = await mkProposal(s.organizationId)
      const res = await accept(p.id)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.status, 'accepted')
      assert.ok(body.templateId, 'returns the new template id')

      const tmpl = await prisma.agentTemplate.findFirst({ where: { id: body.templateId, organizationId: s.organizationId } })
      assert.ok(tmpl, 'a real AgentTemplate exists')
      assert.equal(tmpl.source, 'ai_generated')
      assert.equal(tmpl.visibility, 'org')
      assert.equal(tmpl.name, 'Weekly Digest')
      assert.equal(tmpl.type, 'Sales', 'category lifted to the type column')
      assert.deepEqual(tmpl.configuration, {
        instructions: 'You build the digest.',
        integrations: ['Slack'],
        exampleOutput: 'A digest.',
        model: 'claude-sonnet-5',
      })

      const got = await prisma.templateProposal.findFirst({ where: { id: p.id, organizationId: s.organizationId } })
      assert.equal(got.status, 'accepted')
      assert.equal(got.createdTemplateId, body.templateId)
    } finally {
      await s.cleanup()
      await prisma.organization.delete({ where: { id: s.organizationId } }).catch(() => {})
    }
  })

  test('accept process_improvement → NO template, returns the editor target, status accepted', async () => {
    const s = await seed()
    try {
      const p = await mkProposal(s.organizationId, {
        kind: 'process_improvement',
        configuration: { targetType: 'flow', targetId: 'flow-42', notes: 'add a retry' },
      })
      const before = await prisma.agentTemplate.count({ where: { organizationId: s.organizationId } })
      const res = await accept(p.id)
      const body = await res.json()
      assert.equal(body.status, 'accepted')
      assert.deepEqual(body.open, { targetType: 'flow', targetId: 'flow-42' })

      const after = await prisma.agentTemplate.count({ where: { organizationId: s.organizationId } })
      assert.equal(after, before, 'no template created for a process_improvement')

      const got = await prisma.templateProposal.findFirst({ where: { id: p.id, organizationId: s.organizationId } })
      assert.equal(got.status, 'accepted')
      assert.equal(got.createdTemplateId, null)
    } finally {
      await s.cleanup()
      await prisma.organization.delete({ where: { id: s.organizationId } }).catch(() => {})
    }
  })

  test('accept agent_template → also provisions a LIVE agent the user can find', async () => {
    const s = await seed()
    try {
      const p = await mkProposal(s.organizationId, {
        configuration: {
          name: 'Weekly Digest',
          category: 'Sales',
          instructions: 'You build the digest.',
          integrations: ['slack'],
          model: 'claude-sonnet-5',
          schedule: 'weekly',
        },
      })
      const body = await (await accept(p.id)).json()
      assert.ok(body.agentId, 'accept returns the live agent id')
      const agent = await prisma.agentTask.findFirst({ where: { id: body.agentId, organizationId: s.organizationId } })
      assert.ok(agent, 'a real agent exists in the workspace')
      assert.equal(agent.status, 'ACTIVE')
      assert.equal(agent.metadata.title, 'Weekly Digest')
      assert.equal(agent.metadata.templateId, body.templateId, 'agent records the template it came from')
    } finally {
      await s.cleanup()
      await prisma.organization.delete({ where: { id: s.organizationId } }).catch(() => {})
    }
  })

  test('accept flow_template when the graph cannot be generated → still lands a LIVE agent, never a silent no-op', async () => {
    const s = await seed()
    // No model endpoint configured → generateFlowGraph throws, the same way a
    // model outage or a 120s timeout does in production.
    const keys = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, QWEN_API_KEY: process.env.QWEN_API_KEY, QWEN_BASE_URL: process.env.QWEN_BASE_URL }
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.QWEN_API_KEY
    delete process.env.QWEN_BASE_URL
    try {
      const p = await mkProposal(s.organizationId, { kind: 'flow_template' })
      const body = await (await accept(p.id)).json()
      assert.ok(body.agentId, 'falls back to provisioning an agent instead of returning a bare template id')
      const agent = await prisma.agentTask.findFirst({ where: { id: body.agentId, organizationId: s.organizationId } })
      assert.ok(agent, 'the agent really exists')
      assert.equal(agent.objective, 'You build the digest.', 'built from the proposal instructions')
    } finally {
      Object.entries(keys).forEach(([k, v]) => { if (v !== undefined) process.env[k] = v })
      await s.cleanup()
      await prisma.organization.delete({ where: { id: s.organizationId } }).catch(() => {})
    }
  })

  test('accept twice → idempotent: one template, one agent, second accept still lands on it', async () => {
    const s = await seed()
    try {
      const p = await mkProposal(s.organizationId)
      const first = await (await accept(p.id)).json()
      const second = await (await accept(p.id)).json()
      assert.equal(second.status, 'accepted')
      assert.equal(second.templateId, first.templateId, 'same template id, no re-create')
      assert.equal(second.agentId, first.agentId, 're-applying lands on the agent it already created')
      const count = await prisma.agentTemplate.count({ where: { organizationId: s.organizationId } })
      assert.equal(count, 1, 'exactly one template created across two accepts')
      const agents = await prisma.agentTask.count({ where: { organizationId: s.organizationId } })
      assert.equal(agents, 1, 'exactly one agent created across two accepts')
    } finally {
      await s.cleanup()
      await prisma.organization.delete({ where: { id: s.organizationId } }).catch(() => {})
    }
  })

  test('dismiss → terminal + idempotent, org-scoped', async () => {
    const s = await seed()
    try {
      const p = await mkProposal(s.organizationId)
      const res = await dismiss(p.id)
      const body = await res.json()
      assert.equal(body.status, 'dismissed')
      assert.equal((await prisma.templateProposal.findFirst({ where: { id: p.id, organizationId: s.organizationId } })).status, 'dismissed')
      // Idempotent: a second dismiss stays dismissed.
      assert.equal((await (await dismiss(p.id)).json()).status, 'dismissed')
      // Dismissed proposals drop out of the open list.
      assert.deepEqual((await (await list()).json()).proposals, [])
    } finally {
      await s.cleanup()
      await prisma.organization.delete({ where: { id: s.organizationId } }).catch(() => {})
    }
  })

  test('cross-org accept and dismiss → 404, the owning org row is untouched', async () => {
    const owner = await seedTestOrg(prisma)
    const other = await seedTestOrg(prisma)
    try {
      const p = await mkProposal(owner.organizationId)
      // Auth as the OTHER org.
      installTestAuth(other.auth)
      assert.equal((await accept(p.id)).status, 404)
      assert.equal((await dismiss(p.id)).status, 404)
      const untouched = await prisma.templateProposal.findFirst({ where: { id: p.id, organizationId: owner.organizationId } })
      assert.equal(untouched.status, 'open')
      assert.equal(untouched.createdTemplateId, null)
    } finally {
      await owner.cleanup()
      await other.cleanup()
      await prisma.organization.delete({ where: { id: owner.organizationId } }).catch(() => {})
      await prisma.organization.delete({ where: { id: other.organizationId } }).catch(() => {})
    }
  })

  test('GET list → open proposals for the org, newest-first', async () => {
    const s = await seed()
    try {
      await mkProposal(s.organizationId, { title: 'older', createdAt: new Date('2020-01-01T00:00:00Z') })
      await mkProposal(s.organizationId, { title: 'newer', createdAt: new Date('2020-06-01T00:00:00Z') })
      const body = await (await list()).json()
      assert.equal(body.success, true)
      assert.deepEqual(body.proposals.map((p: any) => p.title), ['newer', 'older'])
    } finally {
      await s.cleanup()
      await prisma.organization.delete({ where: { id: s.organizationId } }).catch(() => {})
    }
  })
}

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { enterTestTenant } from '@/lib/server/__tests__/test-tenant'

/**
 * The AI opt-out has to STOP work, not just describe it.
 *
 * `aiEgressPolicy: 'blocked'` was enforced on eleven interactive routes and on
 * neither of the two paths that carry almost every prompt this platform sends —
 * agent runs and flow AI steps recorded what crossed and then sent it anyway.
 * These tests pin the enforcement on both, and pin that an ordinary workspace is
 * untouched by it (the failure that would make the switch unshippable is not
 * "blocked leaks", it is "everyone is blocked").
 */

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  // A model client is CONSTRUCTED before the gate is reached. Without a key the
  // agent runtime fails on "no provider configured" and the blocked cases would
  // pass for the wrong reason. Forced to a dummy (not `??=`) so an environment
  // holding a real key cannot make the allowed-workspace cases spend tokens:
  // they only need to get PAST the gate, and a 401 proves that.
  process.env.ANTHROPIC_API_KEY = 'test-key-not-used'
  delete process.env.QWEN_API_KEY

  let prisma: any
  let aiEgressRefusal: any
  let runAgentExecution: any
  let startFlowExecution: any
  let flushDetachedFlowExecutions: any

  const ids: Record<string, string> = {}

  // trigger → ai → the smallest graph whose single step reaches a model.
  const aiGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: {} },
      {
        id: 'ai',
        type: 'ai',
        position: { x: 0, y: 0 },
        data: { aiOp: 'ask', instructions: 'Say hello.', input: 'a customer', model: 'fast' },
      },
    ],
    edges: [{ id: 'e-ai', source: 'trigger', target: 'ai' }],
  }

  const makeOrg = async (policy: 'allowed' | 'blocked') => {
    const org = await prisma.organization.create({
      data: { name: `Egress ${policy}`, slug: `egress-${policy}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, aiEgressPolicy: policy },
    })
    const user = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: org.id } })
    // Operate as the org just made: the assertions read flow_run_steps, which
    // are tenanted through their run rather than a column of their own.
    enterTestTenant(org.id)
    return { orgId: org.id, userId: user.id }
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ aiEgressRefusal } = await import('../ai-guard'))
    ;({ runAgentExecution } = await import('@/features/agents/execute-agent'))
    ;({ startFlowExecution, flushDetachedFlowExecutions } = await import('@/features/flows/execute-flow'))

    const blocked = await makeOrg('blocked')
    ids.blockedOrg = blocked.orgId
    ids.blockedUser = blocked.userId
    const allowed = await makeOrg('allowed')
    ids.allowedOrg = allowed.orgId
    ids.allowedUser = allowed.userId

    for (const [key, orgId, userId] of [
      ['blockedAgent', ids.blockedOrg, ids.blockedUser],
      ['allowedAgent', ids.allowedOrg, ids.allowedUser],
    ] as const) {
      const agent = await prisma.agentTask.create({
        data: { organizationId: orgId, userId, description: 'Egress probe', objective: 'Say hello to alice@example.com', status: 'ACTIVE' },
      })
      ids[key] = agent.id
    }

    for (const [key, orgId] of [['blockedFlow', ids.blockedOrg], ['allowedFlow', ids.allowedOrg]] as const) {
      const flow = await prisma.flow.create({
        data: { name: 'egress probe', organizationId: orgId, status: 'ACTIVE', graph: aiGraph, publishedGraph: aiGraph },
      })
      ids[key] = flow.id
    }
  })

  after(async () => {
    for (const orgId of [ids.blockedOrg, ids.allowedOrg]) {
      if (!orgId) continue
      await prisma.flow.deleteMany({ where: { organizationId: orgId } })
      await prisma.agentTask.deleteMany({ where: { organizationId: orgId } })
      await prisma.auditEvent.deleteMany({ where: { organizationId: orgId } })
      await prisma.organization.delete({ where: { id: orgId } })
    }
  })

  test('a blocked workspace refuses, and says so in words an administrator can act on', async () => {
    const refusal = await aiEgressRefusal({ organizationId: ids.blockedOrg, userId: ids.blockedUser, surface: 'unit.probe' })
    assert.ok(refusal, 'a blocked workspace must produce a refusal')
    assert.equal(refusal.name, 'AiEgressBlockedError')
    assert.match(refusal.message, /AI processing disabled by policy/)
    assert.match(refusal.message, /Settings/, 'the message must point at where the switch actually lives')
    // No column names, enum values or codes in copy a person reads.
    assert.doesNotMatch(refusal.message, /aiEgressPolicy|AI_EGRESS_BLOCKED|'blocked'/)

    const audited = await prisma.auditEvent.findFirst({
      where: { organizationId: ids.blockedOrg, action: 'ai.egress_blocked' },
    })
    assert.ok(audited, 'the refusal must be audit-logged, not merely thrown')
    assert.equal((audited.detail as any).surface, 'unit.probe')
  })

  test('an allowed workspace produces no refusal and no audit noise', async () => {
    assert.equal(await aiEgressRefusal({ organizationId: ids.allowedOrg, surface: 'unit.probe' }), null)
    const audited = await prisma.auditEvent.count({
      where: { organizationId: ids.allowedOrg, action: 'ai.egress_blocked' },
    })
    assert.equal(audited, 0)
  })

  test('an agent run in a blocked workspace fails before a prompt is built', async () => {
    await assert.rejects(
      () => runAgentExecution({ agentId: ids.blockedAgent, organizationId: ids.blockedOrg, userId: ids.blockedUser, input: 'Email bob@example.com' }),
      /AI processing disabled by policy/,
    )

    const execution = await prisma.agentExecution.findFirst({
      where: { organizationId: ids.blockedOrg, agentTaskId: ids.blockedAgent },
      orderBy: { startedAt: 'desc' },
    })
    assert.ok(execution, 'the run row still exists so the refusal is visible in history')
    assert.equal(execution.status, 'failed')
    assert.match(execution.error ?? '', /AI processing disabled by policy/)

    // The gate must fire BEFORE the recording half — a blocked workspace that
    // still logs a PII egress row has still evaluated the prompt for sending.
    const egressRows = await prisma.auditEvent.count({
      where: { organizationId: ids.blockedOrg, action: 'ai.pii_egress' },
    })
    assert.equal(egressRows, 0, 'nothing may be recorded as having crossed, because nothing crossed')

    const refusals = await prisma.auditEvent.findMany({
      where: { organizationId: ids.blockedOrg, action: 'ai.egress_blocked', resourceType: 'agent_execution' },
    })
    assert.equal(refusals.length, 1)
    assert.equal(refusals[0].resourceId, execution.id)
  })

  test('an agent run in an allowed workspace is never refused by this gate', async () => {
    // It will still fail — the dummy API key cannot reach a provider — but it
    // must get PAST the policy gate to do so, which is the property under test.
    await assert.rejects(
      () => runAgentExecution({ agentId: ids.allowedAgent, organizationId: ids.allowedOrg, userId: ids.allowedUser, input: 'Email bob@example.com' }),
      (error: Error) => {
        assert.doesNotMatch(error.message, /AI processing disabled by policy/)
        return true
      },
    )
    assert.equal(
      await prisma.auditEvent.count({ where: { organizationId: ids.allowedOrg, action: 'ai.egress_blocked' } }),
      0,
    )
  })

  test('a flow AI step in a blocked workspace resolves as a failed step carrying the policy message', async () => {
    const started = await startFlowExecution({ flowId: ids.blockedFlow, organizationId: ids.blockedOrg, userId: ids.blockedUser, input: 'go' })
    await flushDetachedFlowExecutions()

    const steps = await prisma.flowRunStep.findMany({ where: { flowRunId: started.flowRunId } })
    const aiStep = steps.find((step: any) => step.nodeId === 'ai')
    assert.ok(aiStep, 'the AI step must have been attempted and resolved')
    assert.equal(aiStep.status, 'failed')
    assert.match(JSON.stringify(aiStep.error ?? ''), /AI processing disabled by policy/)

    const refusal = await prisma.auditEvent.findFirst({
      where: { organizationId: ids.blockedOrg, action: 'ai.egress_blocked', resourceType: 'flow_run_step' },
    })
    assert.ok(refusal, 'the flow refusal is audited too')
    assert.equal((refusal.detail as any).surface, 'flow.ai_step')
  })

  test('a flow AI step in an allowed workspace is never refused by this gate', async () => {
    const started = await startFlowExecution({ flowId: ids.allowedFlow, organizationId: ids.allowedOrg, userId: ids.allowedUser, input: 'go' })
    await flushDetachedFlowExecutions()

    const steps = await prisma.flowRunStep.findMany({ where: { flowRunId: started.flowRunId } })
    const aiStep = steps.find((step: any) => step.nodeId === 'ai')
    assert.ok(aiStep)
    // The step still fails (no reachable provider) — but not for policy reasons.
    assert.doesNotMatch(JSON.stringify(aiStep.error ?? ''), /AI processing disabled by policy/)
    assert.equal(
      await prisma.auditEvent.count({ where: { organizationId: ids.allowedOrg, action: 'ai.egress_blocked' } }),
      0,
    )
  })
}

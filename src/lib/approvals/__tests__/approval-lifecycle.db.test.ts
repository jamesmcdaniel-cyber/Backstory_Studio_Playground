import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

/**
 * An approval is a promise to run one write for one live run, decided by
 * someone allowed to see that run. Each of these broke it:
 *
 *  - a run that ended (cancelled, reaped, dead-lettered) left its approvals
 *    pending, and approving one executed the write for a run nobody would
 *    ever resume;
 *  - the inbox listed, and anyone could decide, a PRIVATE agent's or flow's
 *    approvals — executing the write with the requester's connection;
 *  - an approved write whose delivery threw marked the approval failed and
 *    left its run paused forever;
 *  - the stuck-approval sweep matched agent runs on `waiting_approval`, a
 *    status no row ever has.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'ci-encryption-key'

  let prisma: any
  let decideApproval: any
  let ApprovalDeliveryError: any
  let visibleApprovalWhere: any
  let reapStuckApprovals: any
  let STUCK_APPROVAL_TIMEOUT_MS: number
  let onAgentRunTerminalized: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ decideApproval, ApprovalDeliveryError } = await import('@/lib/agents/approval'))
    ;({ visibleApprovalWhere } = await import('../visibility'))
    ;({ reapStuckApprovals, STUCK_APPROVAL_TIMEOUT_MS } = await import('../reap'))
    ;({ onAgentRunTerminalized } = await import('@/lib/agents/run-terminal-effects'))
    const { enterTestTenant } = await import('@/lib/server/__tests__/test-tenant')
    const stamp = Date.now()
    const org = await prisma.organization.create({ data: { name: 'Approval lifecycle', slug: `approval-lifecycle-${stamp}` } })
    ids.org = org.id
    enterTestTenant(org.id)
    const owner = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), email: `owner-${stamp}@example.com`, organizationId: org.id } })
    const other = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), email: `other-${stamp}@example.com`, organizationId: org.id } })
    ids.owner = owner.id
    ids.other = other.id
    const shared = await prisma.flow.create({ data: { name: 'Shared flow', organizationId: org.id, userId: owner.id, graph: { nodes: [], edges: [] } } })
    const secret = await prisma.flow.create({ data: { name: 'Secret flow', organizationId: org.id, userId: owner.id, visibility: 'private', graph: { nodes: [], edges: [] } } })
    ids.sharedFlow = shared.id
    ids.secretFlow = secret.id
    const agent = await prisma.agentTask.create({ data: { description: 'Private agent', objective: 'x', organizationId: org.id, userId: owner.id, visibility: 'private' } })
    ids.agent = agent.id
  })

  after(async () => {
    await prisma.approvalRequest.deleteMany({ where: { organizationId: ids.org } })
    await prisma.flowRunStep.deleteMany({ where: { run: { organizationId: ids.org } } })
    await prisma.flowRun.deleteMany({ where: { organizationId: ids.org } })
    await prisma.flow.deleteMany({ where: { organizationId: ids.org } })
    await prisma.agentExecution.deleteMany({ where: { organizationId: ids.org } })
    await prisma.agentTask.deleteMany({ where: { organizationId: ids.org } })
    await prisma.notification.deleteMany({ where: { organizationId: ids.org } }).catch(() => {})
    await prisma.auditEvent.deleteMany({ where: { organizationId: ids.org } }).catch(() => {})
    await prisma.user.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.delete({ where: { id: ids.org } })
  })

  const flowRun = (flowId: string, status: string) =>
    prisma.flowRun.create({ data: { flowId, status, organizationId: ids.org, userId: ids.owner } })
  const execution = (status: string, agentTaskId: string | null = ids.agent) =>
    prisma.agentExecution.create({
      data: { agentType: 'custom', agentTaskId, input: { prompt: 'x' }, trigger: { type: 'manual' }, status, userId: ids.owner, organizationId: ids.org },
    })
  const approval = (executionId: string, extra: Record<string, unknown> = {}) =>
    prisma.approvalRequest.create({
      data: {
        organizationId: ids.org,
        executionId,
        tool: 'update_record',
        summary: 'update_record (crm)',
        status: 'pending',
        payload: { provider: 'mcp:crm', args: { name: 'Acme' }, userId: ids.owner, mcpConnectionId: 'missing-connection' },
        ...extra,
      },
    })
  const statusOf = async (id: string) => (await prisma.approvalRequest.findFirst({ where: { id, organizationId: ids.org } })).status
  const decide = (approvalId: string, deciderUserId: string, approve = true) =>
    decideApproval({ approvalId, organizationId: ids.org, deciderUserId, approve })

  test('deciding an approval whose flow run was cancelled is refused, and the approval retired', async () => {
    const run = await flowRun(ids.sharedFlow, 'cancelled')
    const row = await approval(run.id)
    await assert.rejects(decide(row.id, ids.owner), (error: any) => error.code === 'APPROVAL_RUN_ENDED' && error.status === 409 && /cancelled/.test(error.message))
    assert.equal(await statusOf(row.id), 'superseded')
  })

  test('so is one whose agent run already finished, or no longer exists', async () => {
    const done = await execution('completed', null)
    const row = await approval(done.id)
    await assert.rejects(decide(row.id, ids.owner, false), (error: any) => error.code === 'APPROVAL_RUN_ENDED')
    const orphan = await approval('no-such-run')
    await assert.rejects(decide(orphan.id, ids.owner), (error: any) => error.code === 'APPROVAL_RUN_ENDED')
    assert.equal(await statusOf(orphan.id), 'superseded')
  })

  test('a private flow’s or agent’s approvals are its owner’s alone — listed and decided', async () => {
    const secretRun = await flowRun(ids.secretFlow, 'waiting')
    const sharedRun = await flowRun(ids.sharedFlow, 'waiting')
    const privateExecution = await execution('waiting_for_approval')
    const secret = await approval(secretRun.id)
    const open = await approval(sharedRun.id)
    const agentRow = await approval(privateExecution.id)

    const listed = async (userId: string) =>
      (await prisma.approvalRequest.findMany({ where: await visibleApprovalWhere(ids.org, userId, ['pending']), select: { id: true } })).map((row: any) => row.id)
    const otherSees = await listed(ids.other)
    assert.ok(otherSees.includes(open.id), 'a shared flow’s approval stays in everyone’s inbox')
    assert.ok(!otherSees.includes(secret.id), 'a private flow’s approval is not listed to someone else')
    assert.ok(!otherSees.includes(agentRow.id), 'a private agent’s approval is not listed to someone else')
    const ownerSees = await listed(ids.owner)
    assert.ok(ownerSees.includes(secret.id) && ownerSees.includes(agentRow.id))

    await assert.rejects(decide(secret.id, ids.other, false), /Approval not found/)
    await assert.rejects(decide(agentRow.id, ids.other, false), /Approval not found/)
    assert.equal(await statusOf(secret.id), 'pending', 'a refused decider changes nothing')
    // The owner can still decide it.
    const result = await decide(secret.id, ids.owner, false)
    assert.equal(result.status, 'rejected')
  })

  test('an approved write that fails to deliver resumes its paused run with the failure', async () => {
    const run = await flowRun(ids.sharedFlow, 'waiting')
    const row = await approval(run.id)
    let thrown: any
    try {
      await decide(row.id, ids.owner)
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown instanceof ApprovalDeliveryError, `expected a delivery error, got ${thrown}`)
    assert.equal(thrown.resumeFlow?.flowRunId, run.id, 'the caller is handed the run to resume')
    assert.match(JSON.parse(thrown.resumeFlow.reply).status, /failed/)
    const stored = await prisma.approvalRequest.findFirst({ where: { id: row.id, organizationId: ids.org } })
    assert.equal(stored.status, 'failed')
    assert.ok(stored.payload.outcome?.error, 'the delivery error is kept on the row')

    // The same holds for an agent run paused on its approval.
    const paused = await execution('waiting_for_approval', null)
    const agentRow = await approval(paused.id)
    const agentError: any = await decide(agentRow.id, ids.owner).catch((error: unknown) => error)
    assert.ok(agentError instanceof ApprovalDeliveryError)
    assert.equal(agentError.resume, undefined, 'an execution with no agent has nothing to resume')
  })

  test('re-posting a failed decision hands back the resume again', async () => {
    const run = await flowRun(ids.sharedFlow, 'waiting')
    const row = await approval(run.id, { status: 'failed', payload: { provider: 'mcp:crm', args: {}, userId: ids.owner, outcome: { executed: false, error: 'boom' } } })
    const result = await decide(row.id, ids.owner)
    assert.equal(result.resumeFlow?.flowRunId, run.id)
  })

  test('the stuck-approval sweep fails a paused agent run (waiting_for_approval) and retires its other approvals', async () => {
    const paused = await execution('waiting_for_approval', null)
    const stale = new Date(Date.now() - STUCK_APPROVAL_TIMEOUT_MS - 60_000)
    await approval(paused.id, { status: 'approving', decidedAt: stale, decidedById: ids.owner })
    const sibling = await approval(paused.id)
    await reapStuckApprovals()
    const after = await prisma.agentExecution.findFirst({ where: { id: paused.id, organizationId: ids.org } })
    assert.equal(after.status, 'failed', 'the paused agent run is terminalized, not left waiting forever')
    assert.equal(await statusOf(sibling.id), 'superseded', 'an approval the dead run left pending is retired')
    const notice = await prisma.notification.count({ where: { organizationId: ids.org, executionId: paused.id, type: 'agent.error' } })
    assert.equal(notice, 1, 'the owner hears the run failed')
  })

  test('the agent follow-up is idempotent: a run that is no longer in that status is left alone', async () => {
    const live = await execution('running', null)
    const row = await approval(live.id)
    await onAgentRunTerminalized({ executionId: live.id, status: 'failed' })
    assert.equal(await statusOf(row.id), 'pending', 'a run that did not actually fail keeps its approvals')
  })
}

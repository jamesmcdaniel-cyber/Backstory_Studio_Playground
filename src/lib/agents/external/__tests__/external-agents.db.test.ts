import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { enterTestTenant } from '@/lib/server/__tests__/test-tenant'
import { AGENT_HOST, WEBHOOK_URL, createNetworkStub, createWorkspace, installPublicResolver, replyRequest, waitFor } from './external-fixture'

// DB-gated: registration, dispatch signing, the reply capability, timeouts,
// delivery failures, limits and removal for external (inbound BYOA) agents.
const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) test('external agents (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'
  process.env.NEXT_PUBLIC_APP_URL = 'https://studio.example.com'

  const network = createNetworkStub()
  let prisma: any
  let registry: typeof import('../registry')
  let runAgentExecution: typeof import('@/features/agents/execute-agent').runAgentExecution
  let restoreResolver: () => void
  let orgId: string
  let userId: string

  const register = async (overrides: Record<string, unknown> = {}) =>
    registry.registerExternalAgent({
      organizationId: orgId,
      actorUserId: userId,
      input: { name: 'Scout', roleLabel: 'Researcher', webhookUrl: WEBHOOK_URL, capabilities: 'Answers renewal questions.', ...overrides },
    })

  const dispatch = (agentId: string, input = 'Summarize the Acme renewal') =>
    runAgentExecution({ agentId, organizationId: orgId, userId, input }) as Promise<any>

  const execution = (id: string) => prisma.agentExecution.findFirst({ where: { id, organizationId: orgId } })

  before(async () => {
    ;({ systemPrisma: prisma } = await import('@/lib/prisma'))
    registry = await import('../registry')
    ;({ runAgentExecution } = await import('@/features/agents/execute-agent'))
    restoreResolver = await installPublicResolver()
    network.install()
    ;({ orgId, userId } = await createWorkspace(prisma, 'ext-agents'))
    enterTestTenant(orgId)
  })

  after(async () => {
    network.restore()
    restoreResolver()
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {})
  })

  beforeEach(() => network.reset())

  // ── Registration ─────────────────────────────────────────────────────────

  test('registration creates an EXTERNAL agent, an agents:reply key bound to it, and an encrypted signing secret shown once', async () => {
    const { view, secrets } = await register()
    const agent = await prisma.agentTask.findFirst({ where: { id: view.agentId, organizationId: orgId } })
    assert.equal(agent.agentType, 'EXTERNAL')
    assert.equal(agent.status, 'ACTIVE')
    assert.equal(agent.metadata.title, 'Scout')
    assert.equal(agent.metadata.roleLabel, 'Researcher')
    const row = await prisma.externalAgent.findFirst({ where: { agentTaskId: view.agentId, organizationId: orgId }, include: { apiKey: true } })
    assert.deepEqual(row.apiKey.scopes, ['agents:reply'])
    assert.ok(row.apiKey.expiresAt > new Date(), 'the key is bounded, never unbounded')
    assert.match(secrets.signingSecret, /^bsw_/)
    assert.match(secrets.apiKey.clientSecret, /^bss_/)
    assert.ok(!row.signingSecretCiphertext.includes(secrets.signingSecret), 'the secret is ciphertext at rest')
    assert.ok(!JSON.stringify(view).includes(secrets.signingSecret), 'the view never carries a secret')
    assert.ok(!JSON.stringify(view).includes(secrets.apiKey.clientSecret))
    assert.equal(view.webhookHost, AGENT_HOST)
    const { serializeAgent } = await import('@/lib/agents/serialize')
    assert.equal(serializeAgent(agent).agentType, 'external', 'agentType is on the wire')
  })

  test('registration refuses a webhook that resolves privately, a private literal and plain http', async () => {
    for (const webhookUrl of ['https://private.example.test/hook', 'https://127.0.0.1/hook', 'https://169.254.169.254/latest', 'http://agent.example.test/hook']) {
      await assert.rejects(register({ name: `Bad ${webhookUrl}`, webhookUrl }), (error: any) => error.status === 400 && error.code === 'WEBHOOK_NOT_ALLOWED', webhookUrl)
    }
    assert.equal(await prisma.agentTask.count({ where: { organizationId: orgId, description: { contains: 'Bad ' } } }), 0)
  })

  // ── Dispatch ─────────────────────────────────────────────────────────────

  test('a run parks waiting_for_external and POSTs a task whose signature verifies with the documented algorithm', async () => {
    const { view, secrets } = await register({ name: 'Signer' })
    const result = await dispatch(view.agentId)
    assert.equal(result.status, 'waiting_for_external')
    const row = await execution(result.executionId)
    assert.equal(row.status, 'waiting_for_external')
    assert.ok(row.replyTokenHash && row.replyTokenExpiresAt > new Date())

    assert.equal(network.state.webhook.length, 1)
    const [delivery] = network.state.webhook
    assert.equal(delivery.url, WEBHOOK_URL)
    const expected = createHmac('sha256', secrets.signingSecret).update(`${delivery.headers['x-backstory-timestamp']}.${delivery.body}`).digest('hex')
    assert.equal(delivery.headers['x-backstory-signature'], expected)
    const task = JSON.parse(delivery.body)
    assert.equal(task.executionId, result.executionId)
    assert.equal(task.task.input, 'Summarize the Acme renewal')
    assert.deepEqual(task.context.requester, { displayName: 'Ada Lovelace' })
    assert.match(task.scope.summary, /No platform tools/)
    assert.equal(task.reply.url, `https://studio.example.com/api/v1/agents/executions/${result.executionId}/reply`)
    assert.match(task.reply.token, /^[0-9a-f]{48}$/)
    // Only the hash is stored.
    const { hashToken } = await import('@/lib/crypto/secrets')
    assert.equal(row.replyTokenHash, hashToken(task.reply.token))
    const external = await prisma.externalAgent.findFirst({ where: { agentTaskId: view.agentId, organizationId: orgId } })
    assert.equal(external.lastDeliveryStatus, 'delivered')
  })

  test('a 4xx refusal fails the run at once with the reason; a 5xx is retried by the outbox', async () => {
    const { view } = await register({ name: 'Refuser' })
    network.state.webhookStatus = 401
    await assert.rejects(dispatch(view.agentId), /refused the task \(HTTP 401\)/)
    const failed = await prisma.agentExecution.findFirst({ where: { agentTaskId: view.agentId, organizationId: orgId }, orderBy: { startedAt: 'desc' } })
    assert.equal(failed.status, 'failed')
    assert.equal(failed.replyTokenHash, null)
    const ledger = await prisma.agentAction.findFirst({ where: { organizationId: orgId, runId: failed.id, tool: 'task_sent' } })
    assert.equal(ledger.status, 'failed')

    network.reset()
    network.state.webhookStatus = 503
    const waiting = await dispatch(view.agentId)
    assert.equal(waiting.status, 'waiting_for_external', 'a 5xx leaves the run waiting for the retry')
    const outbox = await prisma.outboxEvent.findFirst({ where: { organizationId: orgId, topic: 'agent.external.task', aggregateId: waiting.executionId } })
    assert.equal(outbox.status, 'pending')
    assert.equal(outbox.attempts, 1)
    network.state.webhookStatus = 200
    const { processOutboxEventById } = await import('@/lib/outbox')
    await prisma.outboxEvent.update({ where: { id: outbox.id, organizationId: orgId }, data: { availableAt: new Date(Date.now() - 1000) } })
    assert.equal(await processOutboxEventById(outbox.id), 'delivered')
    assert.equal(network.state.webhook.length, 2, 'the retry re-delivered the same task')
    assert.equal(JSON.parse(network.state.webhook[1].body).executionId, waiting.executionId)
  })

  test('a webhook that turns private after registration is refused at delivery, not reached', async () => {
    const { view } = await register({ name: 'Rebinder' })
    await prisma.externalAgent.updateMany({ where: { agentTaskId: view.agentId, organizationId: orgId }, data: { webhookUrl: 'https://private.example.test/hook' } })
    await assert.rejects(dispatch(view.agentId), /not allowed/)
    assert.equal(network.state.webhook.length, 0)
  })

  // ── The reply capability ─────────────────────────────────────────────────

  test('a wrong, reused or expired token — or another agent\'s key — gets one identical 404', async () => {
    const { POST } = await import('@/app/api/v1/agents/executions/[id]/reply/route')
    const { view, secrets } = await register({ name: 'Replier' })
    const other = await register({ name: 'Bystander' })
    const result = await dispatch(view.agentId)
    const token = JSON.parse(network.state.webhook.at(-1)!.body).reply.token
    const key = secrets.apiKey.clientSecret
    const answer = async (apiKey: string, replyToken: string) => {
      const response = await POST(replyRequest(result.executionId, apiKey, { replyToken, status: 'completed', output: 'Done.' }))
      return { status: response.status, body: await response.text() }
    }
    const wrong = await answer(key, 'f'.repeat(48))
    assert.equal(wrong.status, 404)
    const foreign = await answer(other.secrets.apiKey.clientSecret, token)
    assert.deepEqual(foreign, wrong, "another agent's key reads exactly like a wrong token")

    const accepted = await answer(key, token)
    assert.equal(accepted.status, 202)
    const reused = await answer(key, token)
    assert.deepEqual(reused, wrong, 'a reused token reads exactly like a wrong one')

    const second = await dispatch(view.agentId)
    const secondToken = JSON.parse(network.state.webhook.at(-1)!.body).reply.token
    await prisma.agentExecution.update({ where: { id: second.executionId, organizationId: orgId }, data: { replyTokenExpiresAt: new Date(Date.now() - 1000) } })
    const expired = await POST(replyRequest(second.executionId, key, { replyToken: secondToken, status: 'completed', output: 'late' }))
    assert.deepEqual({ status: expired.status, body: await expired.text() }, wrong, 'an expired token reads exactly like a wrong one')

    const noKey = await POST(replyRequest(result.executionId, 'bss_not-a-key', { replyToken: token, status: 'completed', output: 'x' }))
    assert.equal(noKey.status, 401)
  })

  test('a reply completes the run through the normal path: output, counters, signal, ledger', async () => {
    const { POST } = await import('@/app/api/v1/agents/executions/[id]/reply/route')
    const { POST: PROGRESS } = await import('@/app/api/v1/agents/executions/[id]/progress/route')
    const { view, secrets } = await register({ name: 'Completer' })
    const result = await dispatch(view.agentId)
    const token = JSON.parse(network.state.webhook.at(-1)!.body).reply.token

    const progress = await PROGRESS(replyRequest(result.executionId, secrets.apiKey.clientSecret, { replyToken: token, message: 'Reading the account history' }, 'progress'))
    assert.equal(progress.status, 202)
    const narrated = await prisma.workflowEvent.findFirst({ where: { executionId: result.executionId, kind: 'external.progress' } })
    assert.equal(narrated.payload.text, 'Reading the account history')

    const response = await POST(replyRequest(result.executionId, secrets.apiKey.clientSecret, {
      replyToken: token,
      status: 'completed',
      output: 'Acme renews in March; risk is low.',
      links: [{ title: 'Brief', url: 'https://agent.example.test/brief/1' }, { url: 'javascript:alert(1)' }],
    }))
    assert.equal(response.status, 202)
    const done = await waitFor(() => execution(result.executionId), (row: any) => row.status === 'completed')
    assert.equal(done.status, 'completed')
    assert.match(done.output.summary, /Acme renews in March/)
    assert.match(done.output.summary, /\[Brief\]\(https:\/\/agent\.example\.test\/brief\/1\)/)
    assert.ok(!done.output.summary.includes('javascript:'))
    assert.equal(done.replyTokenHash, null)
    const agent = await prisma.agentTask.findFirst({ where: { id: view.agentId, organizationId: orgId } })
    assert.equal(agent.executionCount, 1)
    const signal = await prisma.outboxEvent.findFirst({ where: { organizationId: orgId, dedupeKey: `agent:${result.executionId}:completed` } })
    assert.ok(signal, 'agent.completed is emitted like any run')
    const ledger = await prisma.agentAction.findMany({ where: { organizationId: orgId, runId: result.executionId }, orderBy: { createdAt: 'asc' } })
    assert.deepEqual(ledger.map((row: any) => row.tool), ['task_sent', 'reply_received'])
    assert.equal(ledger[0].argsSummary.task, 'Summarize the Acme renewal')
    assert.ok(!JSON.stringify(ledger).includes(token), 'the ledger never keeps the reply token')

    const { GET } = await import('@/app/api/v1/agents/executions/[id]/route')
    const { NextRequest } = await import('next/server')
    const status = await GET(new NextRequest(`https://studio.example.com/api/v1/agents/executions/${result.executionId}`, { headers: { authorization: `Bearer ${secrets.apiKey.clientSecret}` } }))
    const body = await status.json()
    assert.equal(body.data.status, 'completed')
    assert.equal(body.data.replyAccepted, true)
  })

  test('a reply reporting failure fails the run with the agent\'s reason', async () => {
    const { acceptExternalReply } = await import('../settle')
    const { processOutboxEventById } = await import('@/lib/outbox')
    const { view, secrets } = await register({ name: 'Failer' })
    const result = await dispatch(view.agentId)
    const token = JSON.parse(network.state.webhook.at(-1)!.body).reply.token
    const key = await prisma.externalAgent.findFirst({ where: { agentTaskId: view.agentId, organizationId: orgId } })
    void secrets
    const settleId = await acceptExternalReply({ organizationId: orgId, apiKeyId: key.apiKeyId, executionId: result.executionId, presentedToken: token, reply: { status: 'failed', output: 'CRM was unreachable.', links: [] } })
    assert.ok(settleId)
    await processOutboxEventById(settleId!)
    const row = await execution(result.executionId)
    assert.equal(row.status, 'failed')
    assert.equal(row.error, 'CRM was unreachable.')
  })

  test('a run whose agent never answers fails at its deadline with a clear message', async () => {
    const { reapExpiredExternalExecutions } = await import('../settle')
    const { view } = await register({ name: 'Sleeper', replyTimeoutMinutes: 60 })
    const result = await dispatch(view.agentId)
    await prisma.agentExecution.update({ where: { id: result.executionId, organizationId: orgId }, data: { replyTokenExpiresAt: new Date(Date.now() - 60_000) } })
    const { timedOut } = await reapExpiredExternalExecutions(new Date())
    assert.ok(timedOut >= 1)
    const row = await waitFor(() => execution(result.executionId), (value: any) => value.status === 'failed')
    assert.equal(row.status, 'failed')
    assert.equal(row.error, 'Sleeper did not reply within 60 minutes, so the run was stopped.')
    assert.equal(row.replyTokenHash, null)
  })

  test('external runs count against the daily run allowance like any agent run', async () => {
    const { checkDailyRunAllowance } = await import('@/lib/usage/free-tier-limits')
    const { view } = await register({ name: 'Counted' })
    const fresh = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: orgId, name: 'Bea', isActive: true } })
    await runAgentExecution({ agentId: view.agentId, organizationId: orgId, userId: fresh.id, input: 'one' })
    const allowance = await checkDailyRunAllowance('agent', { organizationId: orgId, userId: fresh.id, canReview: false, email: 'bea@customer.example' })
    assert.equal(allowance.used, 1)
  })

  test('pausing stops new tasks; removing revokes the key and fails runs still waiting', async () => {
    const { view } = await register({ name: 'Leaver' })
    const waiting = await dispatch(view.agentId)
    await registry.updateExternalAgent({ organizationId: orgId, actorUserId: userId, agentId: view.agentId, patch: { enabled: false } })
    await assert.rejects(dispatch(view.agentId), /inactive/)

    await registry.removeExternalAgent({ organizationId: orgId, actorUserId: userId, agentId: view.agentId })
    const row = await waitFor(() => execution(waiting.executionId), (value: any) => value.status === 'failed')
    assert.equal(row.status, 'failed')
    assert.match(row.error, /was removed from this workspace/)
    const agent = await prisma.agentTask.findFirst({ where: { id: view.agentId, organizationId: orgId } })
    assert.equal(agent.status, 'DELETED')
    const key = await prisma.apiKey.findFirst({ where: { organizationId: orgId, name: 'External agent: Leaver' } })
    assert.ok(key.revokedAt, 'the reply key is revoked')
    assert.equal(await prisma.externalAgent.count({ where: { agentTaskId: view.agentId, organizationId: orgId } }), 0)
  })

  test('rotating the signing secret signs the next delivery with the new one', async () => {
    const { view, secrets } = await register({ name: 'Rotator' })
    const { secrets: rotated } = await registry.rotateExternalAgentCredential({ organizationId: orgId, actorUserId: userId, agentId: view.agentId, credential: 'signing_secret' })
    assert.ok(rotated.signingSecret && rotated.signingSecret !== secrets.signingSecret)
    await dispatch(view.agentId)
    const delivery = network.state.webhook.at(-1)!
    const signedWith = (secret: string) => createHmac('sha256', secret).update(`${delivery.headers['x-backstory-timestamp']}.${delivery.body}`).digest('hex')
    assert.equal(delivery.headers['x-backstory-signature'], signedWith(rotated.signingSecret!))
    assert.notEqual(delivery.headers['x-backstory-signature'], signedWith(secrets.signingSecret))

    const { secrets: newKey } = await registry.rotateExternalAgentCredential({ organizationId: orgId, actorUserId: userId, agentId: view.agentId, credential: 'api_key' })
    assert.ok(newKey.apiKey?.clientSecret)
    const old = await prisma.apiKey.findFirst({ where: { organizationId: orgId, keyHash: (await import('@/lib/crypto/secrets')).hashToken(secrets.apiKey.clientSecret) } })
    assert.ok(old.revokedAt, 'the old reply key stops working at once')
  })
}

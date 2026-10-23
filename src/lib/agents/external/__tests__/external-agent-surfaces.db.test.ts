import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { enterTestTenant } from '@/lib/server/__tests__/test-tenant'
import { WEBHOOK_URL, createNetworkStub, createWorkspace, installPublicResolver, waitFor } from './external-fixture'

// DB-gated: an external agent's reply reaches every surface that can start
// it — the Slack thread (posted as the teammate), the flow step (the flow
// continues with the output), and the Assistant chat (the reply lands in the
// thread) — through the same seams the Slack and flow tests use.
const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) test('external agent surfaces (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'
  process.env.NEXT_PUBLIC_APP_URL = 'https://studio.example.com'

  const network = createNetworkStub()
  let prisma: any
  let restoreResolver: () => void
  let orgId: string
  let userId: string
  let agentId: string
  let apiKeyId: string

  /** The agent answers the last task it received, as the reply API would. */
  const answerLastTask = async (output: string) => {
    const { acceptExternalReply } = await import('../settle')
    const { processOutboxEventById } = await import('@/lib/outbox')
    const task = JSON.parse(network.state.webhook.at(-1)!.body)
    const settleId = await acceptExternalReply({ organizationId: orgId, apiKeyId, executionId: task.executionId, presentedToken: task.reply.token, reply: { status: 'completed', output, links: [] } })
    assert.ok(settleId, 'the reply was accepted')
    await processOutboxEventById(settleId!)
    return task
  }

  before(async () => {
    ;({ systemPrisma: prisma } = await import('@/lib/prisma'))
    restoreResolver = await installPublicResolver()
    network.install()
    ;({ orgId, userId } = await createWorkspace(prisma, 'ext-surfaces'))
    enterTestTenant(orgId)
    const { registerExternalAgent } = await import('../registry')
    const { view } = await registerExternalAgent({ organizationId: orgId, actorUserId: userId, input: { name: 'Scout', webhookUrl: WEBHOOK_URL } })
    agentId = view.agentId
    apiKeyId = view.apiKey!.id
    const { encryptSecret } = await import('@/lib/crypto/secrets')
    await prisma.integrationSecret.create({
      data: {
        organizationId: orgId, provider: 'slack', authType: 'api_key', isActive: true,
        authConfig: { authType: 'api_key', apiKey: encryptSecret('xoxb-test'), teamId: `T${orgId.slice(0, 6)}`, botUserId: 'U0BOT' },
      },
    })
  })

  after(async () => {
    network.restore()
    restoreResolver()
    await prisma.flow.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {})
  })

  beforeEach(() => network.reset())

  test('a Slack mention gets the reply in its thread, posted as the teammate', async () => {
    const { runAgentExecution } = await import('@/features/agents/execute-agent')
    const execution = await prisma.agentExecution.create({
      data: {
        agentType: 'EXTERNAL', agentTaskId: agentId, status: 'pending', input: { prompt: 'What changed on Acme?' },
        trigger: { type: 'slack_mention', channelId: 'C42', threadTs: '1700.1', placeholderTs: '1700.2', chainDepth: 1, teammateName: 'Scout' },
        userId, organizationId: orgId,
      },
    })
    const started = await runAgentExecution({ executionId: execution.id, agentId, organizationId: orgId, userId, input: 'What changed on Acme?' }) as any
    assert.equal(started.status, 'waiting_for_external')
    const task = JSON.parse(network.state.webhook.at(-1)!.body)
    assert.deepEqual(task.context.slack, { channelId: 'C42', threadTs: '1700.1' })
    assert.equal(task.context.trigger, 'slack_mention')

    await answerLastTask('Acme added two seats this week.')
    const row = await prisma.agentExecution.findFirst({ where: { id: execution.id, organizationId: orgId } })
    assert.equal(row.status, 'completed')
    const update = network.state.slack.find((call) => call.url.includes('chat.update'))
    assert.ok(update, 'the "on it" placeholder is replaced with the answer')
    assert.equal(update.body.ts, '1700.2')
    assert.equal(update.body.text, 'Acme added two seats this week.')
  })

  test('a flow agent step pauses on the external agent and continues with its output', async () => {
    const { runFlowExecution } = await import('@/features/flows/execute-flow')
    const graph = {
      nodes: [
        { id: 'trigger', type: 'trigger', data: {} },
        { id: 'ext', type: 'agent', data: { agentId, input: 'Brief me on {{trigger.input.account}}' } },
        { id: 'after', type: 'transform', data: { fields: [{ name: 'brief', value: 'Got: {{step.ext.output}}' }] } },
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'ext' },
        { id: 'e2', source: 'ext', target: 'after' },
      ],
    }
    const flow = await prisma.flow.create({ data: { name: 'Briefing', organizationId: orgId, userId, status: 'ACTIVE', graph, publishedGraph: graph } })
    const first = await runFlowExecution({ flowId: flow.id, organizationId: orgId, userId, input: { account: 'Acme' }, usePublished: true }) as any
    assert.equal(first.status, 'waiting')
    const task = JSON.parse(network.state.webhook.at(-1)!.body)
    assert.equal(task.task.input, 'Brief me on Acme')
    assert.equal(task.context.trigger, 'flow')
    assert.equal(task.context.flow.flowId, flow.id)
    assert.equal(task.context.flow.runId, first.flowRunId)
    assert.equal(task.context.flow.flowName, 'Briefing')
    const waitingStep = await prisma.flowRunStep.findFirst({ where: { flowRunId: first.flowRunId, nodeId: 'ext', status: 'waiting' } })
    assert.equal(waitingStep.output.waiting.kind, 'external', 'nobody can type an answer into this pause')

    await answerLastTask('Acme is healthy; renewal in March.')
    const run = await waitFor(
      () => prisma.flowRun.findFirst({ where: { id: first.flowRunId, organizationId: orgId } }),
      (value: any) => value.status !== 'waiting' && value.status !== 'running',
    )
    assert.equal(run.status, 'succeeded')
    const after = await prisma.flowRunStep.findFirst({ where: { flowRunId: first.flowRunId, nodeId: 'after' }, orderBy: { order: 'desc' } })
    assert.deepEqual(after.output, { brief: 'Got: Acme is healthy; renewal in March.' })
  })

  test('the Assistant chat sends the message as the task and shows the reply in the same thread', async () => {
    const { respondToExternalAgentChat } = await import('@/app/api/agents/[id]/chat/external')
    const agent = await prisma.agentTask.findFirst({ where: { id: agentId, organizationId: orgId } })
    const auth = { organizationId: orgId, dbUser: { id: userId, email: 'ada@customer.example' }, can: () => true } as any
    const response = await respondToExternalAgentChat({ agent, auth, message: 'Draft the QBR agenda', serialize: (row) => row })
    const sessionId = response.sessionId
    const task = JSON.parse(network.state.webhook.at(-1)!.body)
    assert.equal(task.task.input, 'Draft the QBR agenda')
    assert.equal(task.context.trigger, 'chat')
    assert.deepEqual(task.context.chat, { sessionId })

    await answerLastTask('1. Wins 2. Risks 3. Asks')
    const messages = await prisma.agentChatMessage.findMany({ where: { organizationId: orgId, sessionId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    assert.deepEqual(messages.map((message: any) => message.role), ['user', 'assistant', 'assistant'])
    assert.equal(messages[0].content, 'Draft the QBR agenda')
    assert.match(messages[1].content, /^Sent to Scout/)
    assert.equal(messages[2].content, '1. Wins 2. Risks 3. Asks')
    assert.equal(messages[2].metadata.run.status, 'completed')
  })

  test('a fast agent answering inside the webhook call completes the run before the dispatcher returns', async () => {
    const { runAgentExecution } = await import('@/features/agents/execute-agent')
    network.state.onWebhook = async (captured) => {
      const { acceptExternalReply } = await import('../settle')
      const task = JSON.parse(captured.body)
      await acceptExternalReply({ organizationId: orgId, apiKeyId, executionId: task.executionId, presentedToken: task.reply.token, reply: { status: 'completed', output: 'instant', links: [] } })
    }
    const result = await runAgentExecution({ agentId, organizationId: orgId, userId, input: 'quick one' }) as any
    assert.equal(result.summary, 'instant')
    const row = await prisma.agentExecution.findFirst({ where: { id: result.executionId, organizationId: orgId } })
    assert.equal(row.status, 'completed')
  })
}

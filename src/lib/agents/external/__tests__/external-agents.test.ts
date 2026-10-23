import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { externalDeliveryHeaders, mintReplyToken, mintSigningSecret, verifyExternalDelivery } from '../signing'
import { buildExternalTaskPayload, taskContextFromTrigger } from '../payload'
import { safeLinks } from '../public-api'
import { readExternalReply } from '../settle'
import { EXTERNAL_SCOPE_SUMMARY, isExternalAgentType } from '../types'
import { compensationFor } from '@/lib/nango/compensators'
import { deriveRunWaitingAll } from '@/lib/flows/run-waiting'
import { resolveReplyTarget } from '@/lib/flows/reply-target'
import { isCancellableRunStatus, isWaitingRunStatus } from '@/lib/agents/run-status'

test('a delivery is signed exactly as the docs describe: HMAC-SHA256 over `${timestamp}.${body}`, hex', () => {
  const secret = mintSigningSecret()
  const body = JSON.stringify({ type: 'agent.task', executionId: 'ex1' })
  const headers = externalDeliveryHeaders({ secret, body, executionId: 'ex1', nowSeconds: 1_760_000_000 })
  // The receiver's verification, written independently of our helper.
  const expected = createHmac('sha256', secret).update(`${headers['x-backstory-timestamp']}.${body}`).digest('hex')
  assert.equal(headers['x-backstory-signature'], expected)
  assert.equal(headers['x-backstory-timestamp'], '1760000000')
  assert.equal(headers['x-backstory-delivery'], 'ex1')
  assert.equal(headers['x-backstory-event'], 'agent.task')
  assert.ok(verifyExternalDelivery({ secret, body, timestampSeconds: 1_760_000_000, signature: expected, nowSeconds: 1_760_000_100 }))
})

test('the verifier refuses a tampered body, a wrong secret and a stale timestamp', () => {
  const secret = mintSigningSecret()
  const body = '{"a":1}'
  const { 'x-backstory-signature': signature } = externalDeliveryHeaders({ secret, body, executionId: 'e', nowSeconds: 1000 })
  assert.equal(verifyExternalDelivery({ secret, body: '{"a":2}', timestampSeconds: 1000, signature, nowSeconds: 1000 }), false)
  assert.equal(verifyExternalDelivery({ secret: mintSigningSecret(), body, timestampSeconds: 1000, signature, nowSeconds: 1000 }), false)
  assert.equal(verifyExternalDelivery({ secret, body, timestampSeconds: 1000, signature, nowSeconds: 1000 + 301 }), false)
})

test('secrets and reply tokens are fresh and unguessable', () => {
  assert.match(mintSigningSecret(), /^bsw_[A-Za-z0-9_-]{43}$/)
  assert.match(mintReplyToken(), /^[0-9a-f]{48}$/)
  assert.notEqual(mintReplyToken(), mintReplyToken())
})

test('the task payload carries the request, a display name, its origin, the scope statement and the reply capability', () => {
  const payload = buildExternalTaskPayload({
    executionId: 'ex1',
    agent: { id: 'a1', name: 'Scout' },
    input: 'Summarize the Acme renewal',
    trigger: { type: 'slack_mention', channelId: 'C1', threadTs: '1.0', slackUserId: 'U9', activityEventId: 'evt' },
    requesterName: 'Ada Lovelace',
    replyToken: 'tok',
    replyExpiresAt: new Date('2026-10-23T12:00:00Z'),
    baseUrl: 'https://studio.example.com',
    now: new Date('2026-10-23T11:00:00Z'),
  })
  assert.equal(payload.type, 'agent.task')
  assert.equal(payload.task.input, 'Summarize the Acme renewal')
  assert.deepEqual(payload.context.requester, { displayName: 'Ada Lovelace' })
  assert.deepEqual(payload.context.slack, { channelId: 'C1', threadTs: '1.0' })
  assert.equal(payload.context.trigger, 'slack_mention')
  assert.deepEqual(payload.scope.platformTools, [])
  assert.equal(payload.scope.summary, EXTERNAL_SCOPE_SUMMARY)
  assert.match(payload.scope.summary, /No platform tools/)
  assert.equal(payload.reply.url, 'https://studio.example.com/api/v1/agents/executions/ex1/reply')
  assert.equal(payload.reply.progressUrl, 'https://studio.example.com/api/v1/agents/executions/ex1/progress')
  assert.equal(payload.reply.token, 'tok')
  // Nothing identifying beyond the display name rides along.
  assert.ok(!JSON.stringify(payload).includes('U9'))
  assert.ok(!JSON.stringify(payload).includes('evt'))
})

test('task context names a flow step and a chat session', () => {
  assert.deepEqual(taskContextFromTrigger({ type: 'flow', flowId: 'f1', flowRunId: 'r1', nodeId: 'n1', flowName: 'Renewals' }).flow, { flowId: 'f1', flowName: 'Renewals', runId: 'r1', stepId: 'n1' })
  const chat = taskContextFromTrigger({ type: 'manual', source: 'assistant', chatSessionId: 's1' })
  assert.equal(chat.trigger, 'chat')
  assert.deepEqual(chat.chat, { sessionId: 's1' })
  assert.equal(taskContextFromTrigger({ type: 'schedule' }).trigger, 'schedule')
  assert.equal(taskContextFromTrigger({ type: 'weird' }).trigger, 'other')
})

test('reply links keep only web URLs', () => {
  assert.deepEqual(
    safeLinks([{ url: 'javascript:alert(1)' }, { title: 'Deck', url: 'https://x.example/deck' }, { url: 'data:text/html,hi' }]),
    [{ title: 'Deck', url: 'https://x.example/deck' }],
  )
})

test('a settled reply is read back from the execution metadata, and nothing else counts as one', () => {
  assert.equal(readExternalReply({}), null)
  assert.equal(readExternalReply({ external: { reply: { status: 'maybe' } } }), null)
  const reply = readExternalReply({ external: { reply: { status: 'completed', output: 'done', links: [{ url: 'https://a.example' }], source: 'agent', receivedAt: 't' } } })
  assert.equal(reply?.status, 'completed')
  assert.deepEqual(reply?.links, [{ title: 'https://a.example', url: 'https://a.example' }])
})

test('external agents are recognised by type, and their pause is waiting and cancellable', () => {
  assert.ok(isExternalAgentType('EXTERNAL'))
  assert.ok(!isExternalAgentType('CUSTOM'))
  assert.ok(isWaitingRunStatus('waiting_for_external'))
  assert.ok(isCancellableRunStatus('waiting_for_external'))
})

test('a flow step waiting on an external agent is an "external" pause no person can answer', () => {
  const waiting = deriveRunWaitingAll('waiting', [{ nodeId: 'ext', status: 'waiting', output: { waiting: { kind: 'external', question: 'Waiting for Scout' } } }])
  assert.equal(waiting[0].kind, 'external')
  assert.equal(resolveReplyTarget({ status: 'waiting' }, { nodeId: 'ext' }, waiting[0]), 'external-block')
})

test('the action ledger says a task handed over cannot be recalled', () => {
  const sent = compensationFor({ plane: 'external', provider: 'external:agent.example.com', tool: 'task_sent' })
  assert.equal(sent.undoable, false)
  const reply = compensationFor({ plane: 'external', provider: 'external:agent.example.com', tool: 'reply_received' })
  assert.equal(reply.undoable, false)
})

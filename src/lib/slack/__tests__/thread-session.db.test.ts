import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) test('thread session (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let prisma: any
  let threadSession: any
  let recordThreadTurn: any
  let withThreadContext: any
  let orgId: string
  let userId: string
  let agentId: string
  const CHANNEL = `C${crypto.randomUUID().slice(0, 8)}`
  const THREAD = '1750000000.000001'

  before(async () => {
    ;({ systemPrisma: prisma } = await import('@/lib/prisma'))
    ;({ threadSession, recordThreadTurn, withThreadContext } = await import('@/lib/slack/thread-session'))

    const suffix = crypto.randomUUID().slice(0, 8)
    const org = await prisma.organization.create({ data: { name: `ts-${suffix}`, slug: `ts-${suffix}` } })
    orgId = org.id
    const user = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), email: `ts-${suffix}@example.test`, organizationId: orgId },
    })
    userId = user.id
    const agent = await prisma.agentTask.create({
      data: { organizationId: orgId, userId, description: 'Scout', objective: 'o' },
    })
    agentId = agent.id
  })

  after(async () => {
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {})
  })

  test('the same thread resolves to the same session', async () => {
    const first = await threadSession({ organizationId: orgId, agentTaskId: agentId, userId, channelId: CHANNEL, threadTs: THREAD })
    const second = await threadSession({ organizationId: orgId, agentTaskId: agentId, userId, channelId: CHANNEL, threadTs: THREAD })
    assert.equal(second.id, first.id, 'a follow-up must continue the conversation, not start a new one')
  })

  test('prior turns come back oldest-first, so the transcript reads forwards', async () => {
    const session = await threadSession({ organizationId: orgId, agentTaskId: agentId, userId, channelId: CHANNEL, threadTs: THREAD })
    await recordThreadTurn({ organizationId: orgId, agentTaskId: agentId, userId, sessionId: session.id, role: 'user', content: 'what changed on Acme?' })
    await recordThreadTurn({ organizationId: orgId, agentTaskId: agentId, userId, sessionId: session.id, role: 'assistant', content: 'Two renewals slipped.' })

    const again = await threadSession({ organizationId: orgId, agentTaskId: agentId, userId, channelId: CHANNEL, threadTs: THREAD })
    assert.equal(again.priorTurns.length, 2)
    assert.equal(again.priorTurns[0].content, 'what changed on Acme?')
    assert.equal(again.priorTurns[1].content, 'Two renewals slipped.')
  })

  test('a different thread is a different conversation', async () => {
    const other = await threadSession({ organizationId: orgId, agentTaskId: agentId, userId, channelId: CHANNEL, threadTs: '1750000000.000002' })
    assert.equal(other.priorTurns.length, 0)
  })

  test('withThreadContext leaves a first message alone and frames a follow-up', () => {
    assert.equal(withThreadContext('hello', []), 'hello')
    const framed = withThreadContext('and last quarter?', [{ role: 'user', content: 'what changed?' }])
    assert.match(framed, /Earlier in this Slack thread/)
    assert.match(framed, /and last quarter\?/)
  })
}

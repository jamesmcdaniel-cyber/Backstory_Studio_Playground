import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) test('slack reply on finish (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let prisma: any
  let finishSlackMention: any
  let orgId: string
  let calls: Array<{ url: string; body: any }> = []
  const originalFetch = globalThis.fetch

  before(async () => {
    ;({ systemPrisma: prisma } = await import('@/lib/prisma'))
    globalThis.fetch = (async (input: any, init: any) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) })
      return new Response(JSON.stringify({ ok: true, ts: '1.1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    ;({ finishSlackMention } = await import('@/lib/slack/reply'))

    const suffix = crypto.randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: { name: `slack-fin-${suffix}`, slug: `slack-fin-${suffix}` },
    })
    orgId = org.id
    const { encryptSecret } = await import('@/lib/crypto/secrets')
    await prisma.integrationSecret.create({
      data: {
        organizationId: orgId, provider: 'slack', authType: 'api_key', isActive: true,
        authConfig: { authType: 'api_key', apiKey: encryptSecret('xoxb-test'), teamId: `T${suffix}`, botUserId: 'U0BOT' },
      },
    })
  })

  after(async () => {
    globalThis.fetch = originalFetch
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {})
  })

  test('a non-Slack trigger posts nothing', async () => {
    calls = []
    await finishSlackMention({ organizationId: orgId, trigger: { type: 'manual' }, text: 'hi' })
    assert.equal(calls.length, 0)
  })

  test('a placeholder is updated in place rather than double-posted', async () => {
    calls = []
    await finishSlackMention({
      organizationId: orgId,
      trigger: { type: 'slack_mention', channelId: 'C1', threadTs: '1.0', placeholderTs: '1.5', chainDepth: 1 },
      teammateName: 'Scout',
      text: 'here is the answer',
    })
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /chat\.update/)
    assert.equal(calls[0].body.ts, '1.5')
    assert.equal(calls[0].body.text, 'here is the answer')
  })

  test('with no placeholder it posts into the thread, stamped with chain depth', async () => {
    calls = []
    await finishSlackMention({
      organizationId: orgId,
      trigger: { type: 'slack_mention', channelId: 'C1', threadTs: '1.0', chainDepth: 2, teammateName: 'Scout' },
      text: 'answer',
    })
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /chat\.postMessage/)
    assert.equal(calls[0].body.thread_ts, '1.0')
    assert.equal(calls[0].body.username, 'Scout')
    // Without this the reply re-enters as depth 0 and the loop guard never trips.
    assert.equal(calls[0].body.metadata.event_payload.chainDepth, 2)
  })

  test('an over-long answer is truncated rather than rejected by Slack', async () => {
    calls = []
    await finishSlackMention({
      organizationId: orgId,
      trigger: { type: 'slack_mention', channelId: 'C1', threadTs: '1.0', placeholderTs: '1.5', chainDepth: 1 },
      teammateName: 'Scout',
      text: 'x'.repeat(5000),
    })
    assert.ok(calls[0].body.text.length < 4000)
    assert.match(calls[0].body.text, /truncated/)
  })

  test('an empty answer still resolves the placeholder', async () => {
    // Otherwise the thread is left saying "is on it…" forever, which reads as
    // the app being broken rather than the run having nothing to say.
    calls = []
    await finishSlackMention({
      organizationId: orgId,
      trigger: { type: 'slack_mention', channelId: 'C1', threadTs: '1.0', placeholderTs: '1.5', chainDepth: 1 },
      teammateName: 'Scout',
      text: '',
    })
    assert.equal(calls.length, 1)
    assert.match(calls[0].body.text, /no output/)
  })
}

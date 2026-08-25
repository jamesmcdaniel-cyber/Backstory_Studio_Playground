import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

/**
 * Mention -> run, against a real database.
 *
 * The cases that matter most are negative: an unlinked Slack user must spend
 * nothing, a redelivered mention must not run twice, and the agent's own reply
 * must never become a new request. Each is a way this surface could quietly
 * cost money or loop.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) test('mention dispatch (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'
  process.env.EXECUTION_MODE = 'inline'

  let prisma: any
  let dispatchSlackMention: any
  let orgId: string
  let userId: string
  let agentId: string
  let posted: Array<Record<string, any>> = []

  const originalFetch = globalThis.fetch

  const seedMention = async (opts: {
    slackUser: string
    text: string
    selfOrigin?: boolean
    chainDepth?: number
  }) => {
    const ts = `${Date.now()}.${Math.floor(Math.random() * 1000000)}`
    const event = await prisma.activityEvent.create({
      data: {
        organizationId: orgId,
        source: 'slack',
        sourceEventId: `slack:mention:C1:${ts}`,
        kind: 'agent.mentioned',
        occurredAt: new Date(),
        actorExternalId: opts.slackUser,
        ownerUserId: null,
        visibility: 'org',
        selfOrigin: opts.selfOrigin ?? false,
        chainDepth: opts.chainDepth ?? 0,
        // A TOP-LEVEL mention: threadTs is null and only `ts` is set. This is
        // the common case, and the one a dispatcher requiring threadTs drops.
        subject: { channelId: 'C1', threadTs: null, ts },
        payload: { event: { text: opts.text, channel: 'C1', ts } },
      },
    })
    return event.id
  }

  const runCount = async () =>
    prisma.agentExecution.count({ where: { organizationId: orgId, agentTaskId: agentId } })

  before(async () => {
    ;({ systemPrisma: prisma } = await import('@/lib/prisma'))

    globalThis.fetch = (async (input: any, init: any) => {
      posted.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) })
      return new Response(JSON.stringify({ ok: true, ts: '1750000000.000999' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    ;({ dispatchSlackMention } = await import('@/lib/slack/mention-dispatch'))

    const suffix = crypto.randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: { name: `slack-md-${suffix}`, slug: `slack-md-${suffix}` },
    })
    orgId = org.id
    const user = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), email: `md-${suffix}@example.test`, organizationId: orgId },
    })
    userId = user.id
    const agent = await prisma.agentTask.create({
      data: {
        organizationId: orgId, userId, description: 'Scout', objective: 'research',
        metadata: { title: 'Scout' },
      },
    })
    agentId = agent.id

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

  test('an unlinked Slack user runs nothing and is told to link', async () => {
    posted = []
    const before = await runCount()
    const eventId = await seedMention({ slackUser: 'U_UNKNOWN', text: '<@U0BOT> Scout go' })

    const result = await dispatchSlackMention(eventId)
    assert.equal(result.outcome, 'unlinked')
    assert.equal(await runCount(), before, 'an unlinked mention must not start a run')
    // Assert on PRESENCE, not position: the run-start handler is
    // fire-and-forget, so another test's async failure update can interleave.
    const link = posted.find((p) => /connect your slack/i.test(String(p.body.text)))
    // Actionable, not just instructive: a fail-closed rule with nowhere to go
    // reads as a broken app.
    assert.match(String(link?.body.text ?? ''), /integrations\?connect=slack|Integrations/)
    assert.ok(link, 'it still replies, so the person knows why nothing happened')
    // A top-level mention threads against its own ts.
    assert.ok(link.body.thread_ts, 'the reply must be threaded, not dropped in the channel')
  })

  test('a self-origin mention is ignored entirely', async () => {
    posted = []
    const before = await runCount()
    const eventId = await seedMention({ slackUser: 'U0BOT', text: '<@U0BOT> hi', selfOrigin: true })
    const result = await dispatchSlackMention(eventId)
    assert.equal(result.outcome, 'skipped')
    assert.equal(await runCount(), before)
    assert.equal(posted.length, 0)
  })

  test('a depth-capped mention is ignored, so a reply loop terminates', async () => {
    posted = []
    const before = await runCount()
    const eventId = await seedMention({ slackUser: 'U_LINKED', text: '<@U0BOT> Scout loop', chainDepth: 3 })
    const result = await dispatchSlackMention(eventId)
    assert.equal(result.outcome, 'skipped')
    assert.equal(await runCount(), before)
  })

  test('a linked user naming a teammate starts exactly one run, as them', async () => {
    await prisma.slackIdentity.create({
      data: { organizationId: orgId, slackUserId: 'U_LINKED', userId },
    })
    posted = []
    const before = await runCount()
    const eventId = await seedMention({ slackUser: 'U_LINKED', text: '<@U0BOT> Scout what changed?' })

    const result = await dispatchSlackMention(eventId)
    assert.equal(result.outcome, 'ran')
    assert.equal(await runCount(), before + 1)

    const execution = await prisma.agentExecution.findFirst({
      where: { organizationId: orgId, agentTaskId: agentId },
      orderBy: { startedAt: 'desc' },
    })
    // Runs as the ASKING human, not the agent's owner.
    assert.equal(execution.userId, userId)
    assert.equal(execution.trigger.type, 'slack_mention')
    assert.ok(String(execution.idempotencyKey ?? '').startsWith('mention:'))
    // The placeholder posts as the teammate, not a generic bot.
    assert.ok(posted.some((p) => p.body.username === 'Scout'), 'the placeholder wears the teammate name')
  })

  test('a redelivered mention does not run or post twice', async () => {
    const eventId = await seedMention({ slackUser: 'U_LINKED', text: '<@U0BOT> Scout again' })
    await dispatchSlackMention(eventId)
    const afterFirst = await runCount()
    posted = []

    const second = await dispatchSlackMention(eventId)
    assert.equal(second.outcome, 'skipped')
    assert.equal(await runCount(), afterFirst, 'the idempotency key must absorb the replay')
    // No PLACEHOLDER for the replay. A late failure update from the first run
    // may still arrive, so exclude chat.update and assert on new posts only.
    assert.equal(
      posted.filter((p) => /chat\.postMessage/.test(p.url)).length,
      0,
      'it must not double-post',
    )
  })

  test('a bare mention in an unbound channel asks which teammate', async () => {
    posted = []
    const before = await runCount()
    const eventId = await seedMention({ slackUser: 'U_LINKED', text: '<@U0BOT> what changed?' })
    const result = await dispatchSlackMention(eventId)
    assert.equal(result.outcome, 'asked')
    assert.equal(await runCount(), before)
    assert.ok(posted.some((p) => /which teammate/i.test(String(p.body.text))))
  })

  test('a bare mention in a BOUND channel runs that channel default', async () => {
    await prisma.slackChannelBinding.create({
      data: { organizationId: orgId, channelId: 'C1', agentTaskId: agentId },
    })
    posted = []
    const before = await runCount()
    const eventId = await seedMention({ slackUser: 'U_LINKED', text: '<@U0BOT> what changed?' })
    const result = await dispatchSlackMention(eventId)
    assert.equal(result.outcome, 'ran')
    assert.equal(await runCount(), before + 1)
  })
}

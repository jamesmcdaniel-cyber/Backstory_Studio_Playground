import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

/**
 * The slash-command receiver, against a real Postgres.
 *
 * Covers the rulings in the route's and the dispatcher's doc comments:
 *  - an unknown team_id and a bad signature for a KNOWN team return the SAME
 *    response, so the endpoint is not an oracle for which workspaces are
 *    connected;
 *  - a verified command from an UNLINKED Slack user starts no run — fail
 *    closed, the same identity ruling mentions follow;
 *  - a verified command with no binding starts no run and says so;
 *  - a bound command from a linked user creates exactly one pending execution
 *    attributed to that person;
 *  - a redelivery of the same trigger_id does not start a second run.
 *
 * The reply itself goes to response_url, which is stubbed here: this file
 * asserts what the route DOES, not what Slack renders.
 */

const TEST_DB = process.env.TEST_DATABASE_URL
const ENABLED = Boolean(TEST_DB)

if (!ENABLED) {
  test('slack command receiver (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}

if (ENABLED) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let systemPrisma: any
  let encryptSecret: (v: string) => string
  const ids: Record<string, string> = {}
  const SIGNING_SECRET = 'test-command-signing-secret'
  const TEAM_ID = 'T_CMD_TEST'
  const LINKED_SLACK_USER = 'U_LINKED'
  const UNLINKED_SLACK_USER = 'U_STRANGER'

  /** response_url posts are captured, never sent. */
  const responses: Array<{ url: string; body: any }> = []
  const realFetch = globalThis.fetch

  before(async () => {
    ;({ systemPrisma } = await import('@/lib/prisma'))
    ;({ encryptSecret } = await import('@/lib/crypto/secrets'))

    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = typeof input === 'string' ? input : input?.url ?? ''
      if (String(url).includes('hooks.slack.com')) {
        responses.push({ url: String(url), body: JSON.parse(String(init.body ?? '{}')) })
        return new Response('ok', { status: 200 })
      }
      return realFetch(input, init)
    }) as typeof fetch

    const stamp = Date.now()
    const org = await systemPrisma.organization.create({
      data: { name: 'Slack Command Test', slug: `slack-cmd-${stamp}` },
    })
    ids.org = org.id

    const user = await systemPrisma.user.create({
      data: {
        email: `cmd-${stamp}@example.test`,
        name: 'Command Tester',
        organizationId: org.id,
        supabaseId: crypto.randomUUID(),
      },
    })
    ids.user = user.id

    await systemPrisma.integrationSecret.create({
      data: {
        organizationId: org.id,
        provider: 'slack',
        authType: 'api_key',
        authConfig: {
          apiKey: encryptSecret('xoxb-test-token'),
          signingSecret: encryptSecret(SIGNING_SECRET),
          teamId: TEAM_ID,
          botUserId: 'U_BOT',
        },
        isActive: true,
      },
    })

    const agent = await systemPrisma.agentTask.create({
      data: {
        organizationId: org.id,
        userId: user.id,
        description: 'Deal Inspector',
        objective: 'Inspect a deal',
        status: 'ACTIVE',
        metadata: { title: 'Deal Inspector' },
      },
    })
    ids.agent = agent.id

    await systemPrisma.slackIdentity.create({
      data: { organizationId: org.id, slackUserId: LINKED_SLACK_USER, userId: user.id },
    })
    await systemPrisma.slackCommandBinding.create({
      data: { organizationId: org.id, command: 'dealcheck', agentTaskId: agent.id },
    })
  })

  after(async () => {
    globalThis.fetch = realFetch
    if (ids.org) {
      await systemPrisma.agentExecution.deleteMany({ where: { organizationId: ids.org } })
      await systemPrisma.slackCommandBinding.deleteMany({ where: { organizationId: ids.org } })
      await systemPrisma.slackIdentity.deleteMany({ where: { organizationId: ids.org } })
      await systemPrisma.agentTask.deleteMany({ where: { organizationId: ids.org } })
      await systemPrisma.integrationSecret.deleteMany({ where: { organizationId: ids.org } })
      await systemPrisma.user.deleteMany({ where: { organizationId: ids.org } })
      await systemPrisma.organization.deleteMany({ where: { id: ids.org } })
    }
  })

  function sign(secret: string, timestamp: string, rawBody: string): string {
    return `v0=${crypto.createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`, 'utf8').digest('hex')}`
  }

  let triggerSeq = 0
  async function send(
    fields: Record<string, string>,
    opts: { secret?: string; badSignature?: boolean } = {},
  ) {
    triggerSeq += 1
    const raw = new URLSearchParams({
      team_id: TEAM_ID,
      command: '/dealcheck',
      text: 'Acme renewal',
      user_id: LINKED_SLACK_USER,
      channel_id: 'C_TEST',
      channel_name: 'revenue',
      response_url: 'https://hooks.slack.com/commands/T/1/abc',
      trigger_id: `trigger-${triggerSeq}`,
      ...fields,
    }).toString()
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = opts.badSignature
      ? `v0=${'0'.repeat(64)}`
      : sign(opts.secret ?? SIGNING_SECRET, timestamp, raw)
    const { POST } = await import('../route')
    return POST(
      new NextRequest('https://app.test/api/slack/commands', {
        method: 'POST',
        body: raw,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
      }),
    )
  }

  /** The dispatch is fire-and-forget; let its microtasks and queries settle. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 250))

  const executions = () =>
    systemPrisma.agentExecution.findMany({ where: { organizationId: ids.org }, select: { id: true, userId: true, trigger: true, input: true } })

  test('an unknown team and a bad signature are indistinguishable to the caller', async () => {
    const unknownTeam = await send({ team_id: 'T_NOT_CONNECTED' })
    const badSignature = await send({}, { badSignature: true })
    assert.equal(unknownTeam.status, badSignature.status)
    assert.deepEqual(await unknownTeam.json(), await badSignature.json())
    // Neither may start work.
    await settle()
    assert.equal((await executions()).length, 0)
  })

  test('a signature from another workspace’s secret is rejected', async () => {
    const response = await send({}, { secret: 'some-other-workspaces-secret' })
    assert.equal(response.status, 401)
    await settle()
    assert.equal((await executions()).length, 0)
  })

  test('a verified command from an unlinked Slack user starts nothing and says why', async () => {
    responses.length = 0
    const response = await send({ user_id: UNLINKED_SLACK_USER })
    // Slack still gets its ack inside the 3-second budget.
    assert.equal(response.status, 200)
    await settle()
    assert.equal((await executions()).length, 0, 'guessing who this is would spend a stranger’s allowance')
    assert.match(responses.at(-1)?.body.text ?? '', /Connect your Slack account/)
  })

  test('a verified command with no binding starts nothing and explains', async () => {
    responses.length = 0
    const response = await send({ command: '/unbound' })
    assert.equal(response.status, 200)
    await settle()
    assert.equal((await executions()).length, 0)
    assert.match(responses.at(-1)?.body.text ?? '', /No teammate is set up to answer \/unbound/)
  })

  test('a bound command from a linked user starts exactly one run, as that person', async () => {
    const response = await send({})
    assert.equal(response.status, 200)
    const ack = await response.json()
    assert.equal(ack.response_type, 'ephemeral', 'the acknowledgement is only for the caller')
    await settle()

    const rows = await executions()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].userId, ids.user, 'the run belongs to the person who typed it')
    assert.equal(rows[0].trigger.type, 'slack_command')
    assert.equal(rows[0].trigger.command, 'dealcheck')
    assert.equal(rows[0].input.prompt, 'Acme renewal')
  })

  test('a command typed with different casing reaches the same binding', async () => {
    const before_ = (await executions()).length
    await send({ command: '/DealCheck', text: 'casing check' })
    await settle()
    const rows = await executions()
    assert.equal(rows.length, before_ + 1, 'Slack echoes the command as registered; the binding must not depend on that')
  })

  test('a redelivered command does not start a second billed run', async () => {
    const raw = new URLSearchParams({
      team_id: TEAM_ID,
      command: '/dealcheck',
      text: 'retry me',
      user_id: LINKED_SLACK_USER,
      channel_id: 'C_TEST',
      channel_name: 'revenue',
      response_url: 'https://hooks.slack.com/commands/T/1/abc',
      trigger_id: 'trigger-fixed-retry',
    }).toString()
    const timestamp = String(Math.floor(Date.now() / 1000))
    const { POST } = await import('../route')
    const post = () =>
      POST(
        new NextRequest('https://app.test/api/slack/commands', {
          method: 'POST',
          body: raw,
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'x-slack-request-timestamp': timestamp,
            'x-slack-signature': sign(SIGNING_SECRET, timestamp, raw),
          },
        }),
      )

    await post()
    await settle()
    const afterFirst = (await executions()).length
    // Slack resends a command whose ack it did not see.
    await post()
    await settle()
    assert.equal((await executions()).length, afterFirst, 'trigger_id is the replay guard')
  })

  test('a command with no argument still runs, on a default prompt', async () => {
    await send({ text: '', trigger_id: 'trigger-empty-text' })
    await settle()
    const rows = await executions()
    const latest = rows.at(-1)
    assert.match(String(latest.input.prompt), /Deal Inspector/)
  })
}

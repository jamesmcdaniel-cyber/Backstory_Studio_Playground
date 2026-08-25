import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

/**
 * The OAuth callback against a real database.
 *
 * The callback is the security boundary of the install: it is unauthenticated
 * by session (Slack is the caller) and authenticated ONLY by the encrypted
 * state cookie. Every negative case below is a way someone could otherwise
 * write a Slack token into a workspace they do not own.
 *
 * Shared CI-mode database — assertions are scoped to orgs this suite creates.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) test('slack install callback (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'
  process.env.SLACK_CLIENT_ID = 'client-123'
  process.env.SLACK_CLIENT_SECRET = 'client-secret-123'

  let prisma: any
  let callbackRoute: any
  let encryptSecret: any
  let decryptSecret: any
  let orgA: any
  let orgB: any
  let exchanged: Array<Record<string, string>> = []

  const TEAM = `T${crypto.randomUUID().slice(0, 8)}`

  // Seam: the route talks to Slack through global fetch. Stubbing it keeps the
  // suite offline and lets us assert exactly what was sent to oauth.v2.access.
  const originalFetch = globalThis.fetch
  const stubExchange = (body: Record<string, unknown>) => {
    globalThis.fetch = (async (_input: any, init: any) => {
      const params = new URLSearchParams(String(init?.body ?? ''))
      exchanged.push(Object.fromEntries(params.entries()))
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
  }

  const cookieFor = (state: Record<string, unknown>) => encryptSecret(JSON.stringify(state))

  const callback = async (opts: { code?: string; state?: string; cookie?: string }) => {
    const url = new URL('https://app.example/api/slack/oauth/callback')
    if (opts.code) url.searchParams.set('code', opts.code)
    if (opts.state) url.searchParams.set('state', opts.state)
    const request = new NextRequest(url, {
      headers: opts.cookie ? { cookie: `bslack_oauth=${encodeURIComponent(opts.cookie)}` } : {},
    })
    return callbackRoute.GET(request)
  }

  const slackSecretFor = async (organizationId: string) =>
    prisma.integrationSecret.findUnique({
      where: { organizationId_provider: { organizationId, provider: 'slack' } },
    })

  before(async () => {
    ;({ systemPrisma: prisma } = await import('@/lib/prisma'))
    ;({ encryptSecret, decryptSecret } = await import('@/lib/crypto/secrets'))
    callbackRoute = await import('../oauth/callback/route')

    const suffix = crypto.randomUUID().slice(0, 8)
    orgA = await prisma.organization.create({
      data: { name: `slack-inst-a-${suffix}`, slug: `slack-inst-a-${suffix}` },
    })
    orgB = await prisma.organization.create({
      data: { name: `slack-inst-b-${suffix}`, slug: `slack-inst-b-${suffix}` },
    })
  })

  after(async () => {
    globalThis.fetch = originalFetch
    for (const org of [orgA, orgB]) {
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => {})
    }
  })

  test('a valid install stores the token, teamId and botUserId', async () => {
    exchanged = []
    stubExchange({ ok: true, access_token: 'xoxb-a', bot_user_id: 'U0BOT', team: { id: TEAM } })

    const response = await callback({
      code: 'code-1',
      state: 'st-1',
      cookie: cookieFor({ state: 'st-1', organizationId: orgA.id, userId: 'u1', issuedAt: Date.now() }),
    })
    assert.equal(response.status, 307, 'the callback redirects the browser back into the app')

    const secret = await slackSecretFor(orgA.id)
    assert.ok(secret, 'expected a slack IntegrationSecret for the installing org')
    const config = secret.authConfig as Record<string, unknown>
    assert.equal(config.teamId, TEAM)
    assert.equal(config.botUserId, 'U0BOT')
    // Stored the same way the paste path stores it: encrypted under apiKey.
    assert.equal(decryptSecret(config.apiKey as string), 'xoxb-a')
    // The platform app verifies against the app-level signing secret, so the
    // install must NOT write one of its own.
    assert.equal(config.signingSecret, undefined)
    // The exchange used the app's embedded identity.
    assert.equal(exchanged[0].client_id, 'client-123')
    assert.equal(exchanged[0].client_secret, 'client-secret-123')
    assert.equal(exchanged[0].code, 'code-1')
  })

  test('a state that does not match the cookie writes nothing', async () => {
    exchanged = []
    stubExchange({ ok: true, access_token: 'xoxb-b', bot_user_id: 'U0BOT', team: { id: `T${crypto.randomUUID().slice(0, 8)}` } })

    const response = await callback({
      code: 'code-2',
      state: 'attacker-state',
      cookie: cookieFor({ state: 'real-state', organizationId: orgB.id, userId: 'u2', issuedAt: Date.now() }),
    })
    assert.equal(response.status, 307)
    assert.equal(await slackSecretFor(orgB.id), null)
    assert.equal(exchanged.length, 0, 'a bad state must be refused BEFORE the code is exchanged')
  })

  test('an expired state writes nothing and never exchanges the code', async () => {
    exchanged = []
    stubExchange({ ok: true, access_token: 'xoxb-b', bot_user_id: 'U0BOT', team: { id: `T${crypto.randomUUID().slice(0, 8)}` } })
    const response = await callback({
      code: 'code-old',
      state: 'st-old',
      cookie: cookieFor({
        state: 'st-old',
        organizationId: orgB.id,
        userId: 'u2',
        // Eleven minutes old — past SLACK_STATE_MAX_AGE_MS.
        issuedAt: Date.now() - 11 * 60_000,
      }),
    })
    assert.equal(response.status, 307)
    assert.equal(await slackSecretFor(orgB.id), null)
    assert.equal(exchanged.length, 0)
  })

  test('a missing cookie writes nothing', async () => {
    exchanged = []
    const response = await callback({ code: 'code-3', state: 'st-3' })
    assert.equal(response.status, 307)
    assert.equal(await slackSecretFor(orgB.id), null)
    assert.equal(exchanged.length, 0)
  })

  test('a rejected exchange writes nothing', async () => {
    // Slack answers 200 with ok:false. Trusting the status code here would
    // store an empty token and leave the workspace looking connected.
    stubExchange({ ok: false, error: 'invalid_code' })
    const response = await callback({
      code: 'bad',
      state: 'st-4',
      cookie: cookieFor({ state: 'st-4', organizationId: orgB.id, userId: 'u2', issuedAt: Date.now() }),
    })
    assert.equal(response.status, 307)
    assert.equal(await slackSecretFor(orgB.id), null)
  })

  test('installing a Slack workspace another org already claims is refused', async () => {
    // orgA claimed TEAM in the first test. With ONE shared app this is a
    // realistic mistake, and the failure mode is every delivery for that
    // workspace silently misrouted.
    stubExchange({ ok: true, access_token: 'xoxb-b', bot_user_id: 'U0BOT', team: { id: TEAM } })
    const response = await callback({
      code: 'code-5',
      state: 'st-5',
      cookie: cookieFor({ state: 'st-5', organizationId: orgB.id, userId: 'u2', issuedAt: Date.now() }),
    })
    assert.equal(response.status, 307)
    assert.match(response.headers.get('location') ?? '', /slack_team_taken/)
    assert.equal(await slackSecretFor(orgB.id), null)
  })

  test('re-installing the same workspace overwrites the token and stays working', async () => {
    stubExchange({ ok: true, access_token: 'xoxb-a-rotated', bot_user_id: 'U0BOT', team: { id: TEAM } })
    const response = await callback({
      code: 'code-6',
      state: 'st-6',
      cookie: cookieFor({ state: 'st-6', organizationId: orgA.id, userId: 'u1', issuedAt: Date.now() }),
    })
    assert.equal(response.status, 307)

    const secret = await slackSecretFor(orgA.id)
    const config = secret.authConfig as Record<string, unknown>
    assert.equal(decryptSecret(config.apiKey as string), 'xoxb-a-rotated')
    assert.equal(config.teamId, TEAM, 'reinstall must not drop the routing key')
    assert.equal(secret.isActive, true)
  })
}

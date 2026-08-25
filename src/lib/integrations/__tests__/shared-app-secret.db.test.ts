import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

/**
 * The signing secret and the bot token are different KINDS of secret, and this
 * suite is what keeps them from being governed by one policy.
 *
 * A shared bot token is a shared IDENTITY — a customer workspace holding it
 * could act as, and read what belongs to, every other workspace on the account.
 * That stays denied.
 *
 * A shared signing secret is the app's SIGNATURE VERIFIER. It proves "Slack
 * sent this, from this app" and grants access to nothing. Every workspace
 * installing the same distributable app is supposed to share it.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) test('shared app secret (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let prisma: any
  let getSlackSigningSecret: any
  let getSlackToken: any
  let customerOrgId: string
  const previous = {
    signing: process.env.SLACK_SIGNING_SECRET,
    bot: process.env.SLACK_BOT_TOKEN,
  }

  before(async () => {
    ;({ systemPrisma: prisma } = await import('@/lib/prisma'))
    process.env.SLACK_SIGNING_SECRET = 'app-level-signing-secret'
    process.env.SLACK_BOT_TOKEN = 'xoxb-platform-shared'
    ;({ getSlackSigningSecret, getSlackToken } = await import('@/lib/integrations/slack'))

    const suffix = crypto.randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      // kind defaults to 'customer' — the org kind the guard denies.
      data: { name: `slack-shared-${suffix}`, slug: `slack-shared-${suffix}` },
    })
    customerOrgId = org.id
  })

  after(async () => {
    process.env.SLACK_SIGNING_SECRET = previous.signing
    process.env.SLACK_BOT_TOKEN = previous.bot
    await prisma.organization.delete({ where: { id: customerOrgId } }).catch(() => {})
  })

  test('a customer workspace verifies against the app-level signing secret', async () => {
    const resolved = await getSlackSigningSecret(customerOrgId)
    assert.ok(resolved, 'a customer org installing the platform app must be able to verify deliveries')
    assert.equal(resolved.value, 'app-level-signing-secret')
    assert.equal(resolved.source, 'env')
  })

  test('a customer workspace still cannot reach the shared bot token', async () => {
    // The narrowing above must not widen this. A shared bot token is a shared
    // identity; this is the assertion that keeps the two apart.
    assert.equal(await getSlackToken(customerOrgId), null)
  })
}

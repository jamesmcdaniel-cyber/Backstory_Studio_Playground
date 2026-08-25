import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

/**
 * Capturing who a Slack user is, at connect time.
 *
 * Connect-time capture rather than a lazy first-mention lookup, for the same
 * reason the bot's teamId/botUserId are captured when its token is saved: at
 * mention time we have a Slack user id and nothing to resolve it against, and
 * guessing is what the fail-closed rule exists to prevent.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) test('slack identity (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let prisma: any
  let captureSlackIdentity: any
  let orgId: string
  let userId: string
  let otherUserId: string

  const proxyReturning = (body: Record<string, unknown>) => async () => ({ data: body })

  before(async () => {
    ;({ systemPrisma: prisma } = await import('@/lib/prisma'))
    ;({ captureSlackIdentity } = await import('@/lib/slack/identity'))

    const suffix = crypto.randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: { name: `slack-id-${suffix}`, slug: `slack-id-${suffix}` },
    })
    orgId = org.id
    const user = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), email: `a-${suffix}@example.test`, organizationId: orgId },
    })
    userId = user.id
    const other = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), email: `b-${suffix}@example.test`, organizationId: orgId },
    })
    otherUserId = other.id
  })

  after(async () => {
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {})
  })

  test('a linked Slack account records the mapping', async () => {
    const result = await captureSlackIdentity({
      organizationId: orgId,
      userId,
      connectionId: 'conn-1',
      providerConfigKey: 'slack',
      proxy: proxyReturning({ ok: true, user_id: 'U111', team_id: 'T1' }),
    })
    assert.deepEqual(result, { slackUserId: 'U111' })

    const row = await prisma.slackIdentity.findUnique({
      where: { organizationId_slackUserId: { organizationId: orgId, slackUserId: 'U111' } },
    })
    assert.ok(row)
    assert.equal(row.userId, userId)
  })

  test('re-linking the same person is idempotent', async () => {
    await captureSlackIdentity({
      organizationId: orgId,
      userId,
      connectionId: 'conn-1',
      providerConfigKey: 'slack',
      proxy: proxyReturning({ ok: true, user_id: 'U111' }),
    })
    const rows = await prisma.slackIdentity.findMany({ where: { organizationId: orgId, slackUserId: 'U111' } })
    assert.equal(rows.length, 1)
  })

  test('a Slack account moving to another person re-points, never duplicates', async () => {
    // Otherwise the unique constraint throws and the whole webhook 500s, or
    // worse the old mapping keeps winning and mentions run as the wrong human.
    await captureSlackIdentity({
      organizationId: orgId,
      userId: otherUserId,
      connectionId: 'conn-2',
      providerConfigKey: 'slack',
      proxy: proxyReturning({ ok: true, user_id: 'U111' }),
    })
    const rows = await prisma.slackIdentity.findMany({ where: { organizationId: orgId, slackUserId: 'U111' } })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].userId, otherUserId)
  })

  test('a failed auth.test records nothing', async () => {
    // Slack answers HTTP 200 with ok:false. Writing a row from that would bind
    // a person to an empty Slack id and make every later mention ambiguous.
    const result = await captureSlackIdentity({
      organizationId: orgId,
      userId,
      connectionId: 'conn-3',
      providerConfigKey: 'slack',
      proxy: proxyReturning({ ok: false, error: 'invalid_auth' }),
    })
    assert.equal(result, null)
    assert.equal(await prisma.slackIdentity.count({ where: { organizationId: orgId, slackUserId: '' } }), 0)
  })

  test('a proxy that throws is swallowed, not propagated', async () => {
    // This runs inside the Nango webhook. A Slack outage must not fail the
    // whole connection-mirroring path — the person is still connected, they
    // just cannot summon agents until it is retried.
    const result = await captureSlackIdentity({
      organizationId: orgId,
      userId,
      connectionId: 'conn-4',
      providerConfigKey: 'slack',
      proxy: async () => {
        throw new Error('slack unreachable')
      },
    })
    assert.equal(result, null)
  })
}

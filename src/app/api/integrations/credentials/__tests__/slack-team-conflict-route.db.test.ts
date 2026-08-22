import { test, before, mock } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

/**
 * Task 4 fix round (coordinator review, Critical finding): a Slack `team_id`
 * routes an inbound Events API delivery back to an org
 * (src/app/api/slack/events/route.ts), so two orgs saving a credential that
 * both resolve to the SAME `team_id` is not cosmetic — it's every event for
 * that workspace silently misrouted to whichever org
 * findSlackWorkspaceByTeamId's scan happens to return first, with no error
 * and no audit trail. This covers the guard added to the credential-save
 * path (POST /api/integrations/credentials/slack) that closes that gap.
 *
 * Lives OUTSIDE the `[provider]/__tests__` directory (route imported by
 * relative path instead) because Node's `--test` CLI silently discovers ZERO
 * tests from any file path containing a `[...]` directory segment — verified
 * directly: `find "…/[provider]/__tests__" -name '*.test.ts' | xargs tsx
 * --test` (the exact invocation `npm test` uses) reports `# tests 0` for such
 * a file, with no error. A test file placed there would never actually run
 * under the suite it's supposedly part of.
 */

const TEST_DB = process.env.TEST_DATABASE_URL
const ENABLED = Boolean(TEST_DB)

if (!ENABLED) {
  test('slack credential team_id conflict guard (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}

if (ENABLED) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let prisma: any
  let seedTestOrg: any
  let installTestAuth: any
  let clearTestAuth: any
  let POST: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg, installTestAuth, clearTestAuth } = await import('@/lib/server/__tests__/test-auth'))
    ;({ POST } = await import('../[provider]/route'))
  })

  /** Stand in for Slack's auth.test — verifyCredential's Slack branch calls this. */
  function stubSlackAuthTest(teamId: string, botUserId: string) {
    return mock.method(globalThis, 'fetch', async () =>
      new Response(JSON.stringify({ ok: true, team_id: teamId, user_id: botUserId }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }

  const save = (body: Record<string, unknown>) =>
    POST(
      new NextRequest('https://app.test/api/integrations/credentials/slack', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
    )

  test('a second org claiming an already-connected team_id is rejected, and audited', async () => {
    const teamId = `T_CONFLICT_${Date.now()}`
    const first = await seedTestOrg(prisma)
    const second = await seedTestOrg(prisma)
    try {
      installTestAuth(first.auth)
      stubSlackAuthTest(teamId, 'U_BOT_1')
      const firstRes = await save({ credential: 'xoxb-first-org-token', signingSecret: 'first-org-secret' })
      assert.equal(firstRes.status, 200, 'the first org to claim this team_id succeeds')
      mock.restoreAll()

      installTestAuth(second.auth)
      stubSlackAuthTest(teamId, 'U_BOT_1')
      const secondRes = await save({ credential: 'xoxb-second-org-token', signingSecret: 'second-org-secret' })
      assert.equal(secondRes.status, 409, 'a different org claiming the same team_id is rejected')
      const body = await secondRes.json()
      assert.equal(body.code, 'SLACK_TEAM_ALREADY_CONNECTED')
      assert.match(body.error, /already connected to a different Backstory workspace/)

      const secondOrgSecret = await prisma.integrationSecret.findUnique({
        where: { organizationId_provider: { organizationId: second.organizationId, provider: 'slack' } },
      })
      assert.equal(secondOrgSecret, null, 'the rejected save never persisted anything for the second org')

      const audit = await prisma.auditEvent.findFirst({
        where: { organizationId: second.organizationId, action: 'credential.rejected' },
        orderBy: { createdAt: 'desc' },
      })
      assert.ok(audit, 'the rejection is audited')
      assert.equal((audit.detail as Record<string, unknown>).reason, 'team_id_already_connected')
    } finally {
      mock.restoreAll()
      clearTestAuth()
      await first.cleanup()
      await second.cleanup()
    }
  })

  test('the SAME org re-saving (rotating) its own credential for the same team_id is allowed', async () => {
    const teamId = `T_ROTATE_${Date.now()}`
    const org = await seedTestOrg(prisma)
    try {
      installTestAuth(org.auth)
      stubSlackAuthTest(teamId, 'U_BOT_1')
      const firstRes = await save({ credential: 'xoxb-token-v1', signingSecret: 'signing-secret-v1' })
      assert.equal(firstRes.status, 200)
      mock.restoreAll()

      // Rotating the bot token: same org, same team_id (auth.test resolves the
      // same workspace again) — this must NOT be treated as a conflict with
      // itself.
      stubSlackAuthTest(teamId, 'U_BOT_1')
      const secondRes = await save({ credential: 'xoxb-token-v2' })
      assert.equal(secondRes.status, 200, 're-saving the same org\'s own credential is not a conflict')

      const secret = await prisma.integrationSecret.findUnique({
        where: { organizationId_provider: { organizationId: org.organizationId, provider: 'slack' } },
      })
      assert.ok(secret)
      assert.equal((secret.authConfig as Record<string, unknown>).teamId, teamId)
    } finally {
      mock.restoreAll()
      clearTestAuth()
      await org.cleanup()
    }
  })
}

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

/**
 * Integration test against a throwaway local Postgres (CI provides one as a
 * service container). Skips gracefully when TEST_DATABASE_URL is not set so
 * `npm test` stays green on machines without a local database.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
const ENABLED = Boolean(TEST_DB)

if (!ENABLED) {
  test('connect-service (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}

if (ENABLED) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  // Loaded in before() — tsx compiles tests as CJS, so no top-level await.
  let prisma: any
  let systemPrisma: any
  let completeConnect: any
  let extractIdentity: any
  let TeamMismatchError: any
  let decryptSecret: any

  const ids: { orgA?: string; orgB?: string; user?: string; userB?: string } = {}

  function jwtWith(claims: Record<string, unknown>): string {
    const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url')
    return `mcp_${b64({ alg: 'none' })}.${b64(claims)}.sig`
  }

  const exchanger = async () => ({
    accessToken: jwtWith({ team_id: 'team-77', membership_id: 'member-9' }),
    refreshToken: 'mcp_refresh_1',
    tokenType: 'Bearer',
    raw: {},
  })

  before(async () => {
    ;({ prisma, systemPrisma } = await import('@/lib/prisma'))
    ;({ completeConnect, extractIdentity, TeamMismatchError } = await import('../connect-service'))
    ;({ decryptSecret } = await import('@/lib/crypto/secrets'))

    const orgA = await prisma.organization.create({ data: { name: 'A', slug: `a-${Date.now()}` } })
    const orgB = await prisma.organization.create({
      data: { name: 'B', slug: `b-${Date.now()}`, peopleAiTeamId: 'other-team' },
    })
    const user = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), email: 'a@x.com', organizationId: orgA.id },
    })
    const userB = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), email: 'b@x.com', organizationId: orgB.id },
    })
    ids.orgA = orgA.id
    ids.orgB = orgB.id
    ids.user = user.id
    ids.userB = userB.id
  })

  after(async () => {
    await prisma.peopleAiConnection.deleteMany({ where: { organizationId: { in: [ids.orgA!, ids.orgB!] } } })
    await prisma.user.deleteMany({ where: { id: { in: [ids.user!, ids.userB!] } } })
    await prisma.organization.deleteMany({ where: { id: { in: [ids.orgA!, ids.orgB!] } } })
    await prisma.$disconnect()
  })

  test('extractIdentity reads claims from an mcp_-prefixed JWT', () => {
    const identity = extractIdentity({
      accessToken: jwtWith({ team_id: 't1', membership_id: 'm1' }),
      tokenType: 'Bearer',
      raw: {},
    })
    assert.deepEqual(identity, { teamId: 't1', membershipId: 'm1' })
  })

  test('completeConnect persists an encrypted connection, binds the team, marks entitled', async () => {
    // A real Sales AI grant: within SCOPE_POLICY.people_ai's allowed set and
    // carrying its minimum. completeConnect refuses anything else outright,
    // so a placeholder scope string never reaches the persistence this test
    // is about. Over-scoped grants are covered in the scope-policy tests.
    const config = { clientId: 'c', redirectUri: 'https://x/cb', scope: 'mcp:read mcp:tools offline_access' }
    const identity = await completeConnect({
      userId: ids.user!,
      organizationId: ids.orgA!,
      code: 'code-1',
      verifier: 'v-1',
      config,
      exchanger,
    })
    assert.deepEqual(identity, { teamId: 'team-77', membershipId: 'member-9' })

    // systemPrisma: asserting on the stored row itself, deliberately bypassing
    // the owner-liveness filter the app path is subject to.
    const connection = await systemPrisma.peopleAiConnection.findUnique({
      where: { organizationId_userId: { organizationId: ids.orgA!, userId: ids.user! } },
    })
    assert.ok(connection)
    assert.ok(!connection!.accessToken.startsWith('mcp_'), 'token must not be stored in plaintext')
    assert.match(decryptSecret(connection!.accessToken), /^mcp_/)
    assert.deepEqual(connection!.grantedScopes, ['mcp:read', 'mcp:tools', 'offline_access'])

    const org = await prisma.organization.findUnique({ where: { id: ids.orgA! } })
    assert.equal(org!.peopleAiTeamId, 'team-77')
    assert.equal(org!.entitlementStatus, 'entitled')
    assert.equal(org!.entitlementTier, 'sales_ai')

    const user = await prisma.user.findUnique({ where: { id: ids.user! } })
    assert.equal(user!.peopleAiMembershipId, 'member-9')
  })

  test('a second user from the same team joins the existing team workspace', async () => {
    // userC signs up solo (fresh org), then connects the same team-77 —
    // they must land in orgA (already bound to team-77), and their empty
    // solo org must be cleaned up.
    const soloOrg = await prisma.organization.create({ data: { name: 'Solo', slug: `s-${Date.now()}` } })
    const userC = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), email: 'c@x.com', organizationId: soloOrg.id },
    })

    const config = { clientId: 'c', redirectUri: 'https://x/cb' }
    const outcome = await completeConnect({
      userId: userC.id,
      organizationId: soloOrg.id,
      code: 'code-3',
      verifier: 'v-3',
      config,
      exchanger, // returns team-77 → orgA
    })
    assert.equal(outcome.teamId, 'team-77')

    const moved = await prisma.user.findUnique({ where: { id: userC.id } })
    assert.equal(moved!.organizationId, ids.orgA, 'user should join the team workspace')

    // systemPrisma: asserting on the stored row itself, deliberately bypassing
    // the owner-liveness filter the app path is subject to.
    const connection = await systemPrisma.peopleAiConnection.findUnique({
      where: { organizationId_userId: { organizationId: ids.orgA!, userId: userC.id } },
    })
    assert.ok(connection, 'connection should be scoped to the team workspace')

    const cleaned = await prisma.organization.findUnique({ where: { id: soloOrg.id } })
    assert.equal(cleaned, null, 'empty solo org should be deleted after the move')

    await prisma.peopleAiConnection.deleteMany({ where: { userId: userC.id, organizationId: ids.orgA! } })
    await prisma.user.delete({ where: { id: userC.id } })
  })

  test('connecting a different team into a bound multi-member workspace is refused', async () => {
    const config = { clientId: 'c', redirectUri: 'https://x/cb' }
    await assert.rejects(
      completeConnect({
        userId: ids.userB!,
        organizationId: ids.orgB!, // bound to other-team
        code: 'code-2',
        verifier: 'v-2',
        config,
        exchanger, // returns team-77
      }),
      TeamMismatchError,
    )
  })
}

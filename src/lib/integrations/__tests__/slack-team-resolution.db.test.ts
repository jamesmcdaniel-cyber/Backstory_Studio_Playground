import { test, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Task 4 fix round (coordinator review, Critical finding — defense in depth):
 * `findSlackWorkspaceByTeamId` must never silently pick one of several orgs
 * that (somehow — a collision predating the credential-save guard, or a
 * closeable-but-not-closed race between two concurrent saves, see that
 * guard's own comment) claim the SAME Slack `team_id`. It has to be
 * deterministic across calls (not whatever order an unordered scan returns)
 * AND loud about the situation (error-level log), so a pre-existing
 * collision surfaces instead of quietly misrouting events.
 */

const TEST_DB = process.env.TEST_DATABASE_URL
const ENABLED = Boolean(TEST_DB)

if (!ENABLED) {
  test('slack team_id resolution (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}

if (ENABLED) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let systemPrisma: any
  let encryptSecret: (v: string) => string
  let findSlackWorkspaceByTeamId: (teamId: string) => Promise<{ organizationId: string } | null>
  let findConflictingSlackOrg: (teamId: string, excludeOrganizationId: string) => Promise<string | null>
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ systemPrisma } = await import('@/lib/prisma'))
    ;({ encryptSecret } = await import('@/lib/crypto/secrets'))
    ;({ findSlackWorkspaceByTeamId, findConflictingSlackOrg } = await import('../slack'))
  })

  after(async () => {
    for (const key of ['orgA', 'orgB', 'orgC'] as const) {
      if (ids[key]) {
        await systemPrisma.integrationSecret.deleteMany({ where: { organizationId: ids[key] } })
        await systemPrisma.organization.deleteMany({ where: { id: ids[key] } })
      }
    }
  })

  const makeOrg = async (name: string) => {
    const org = await systemPrisma.organization.create({ data: { name, slug: `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}` } })
    return org.id as string
  }

  const saveSlackCredential = (organizationId: string, teamId: string) =>
    systemPrisma.integrationSecret.create({
      data: {
        organizationId,
        provider: 'slack',
        authType: 'api_key',
        authConfig: {
          apiKey: encryptSecret('xoxb-test'),
          signingSecret: encryptSecret('secret'),
          teamId,
          botUserId: 'U_BOT',
        },
        isActive: true,
      },
    })

  test('findConflictingSlackOrg finds the other org claiming the same team_id', async () => {
    const teamId = `T_MULTI_${Date.now()}`
    ids.orgA = await makeOrg('slack-multi-a')
    ids.orgB = await makeOrg('slack-multi-b')
    await saveSlackCredential(ids.orgA, teamId)
    await saveSlackCredential(ids.orgB, teamId)

    const conflictForA = await findConflictingSlackOrg(teamId, ids.orgA)
    assert.equal(conflictForA, ids.orgB)
    const conflictForB = await findConflictingSlackOrg(teamId, ids.orgB)
    assert.equal(conflictForB, ids.orgA)

    // A third, unrelated org: no conflict, since it doesn't claim this team_id.
    ids.orgC = await makeOrg('slack-multi-c')
    const conflictForC = await findConflictingSlackOrg(teamId, ids.orgC)
    assert.ok(conflictForC === ids.orgA || conflictForC === ids.orgB, 'orgC is not itself a claimant, so any existing claimant is a conflict for it')
  })

  test('a pre-existing multi-claimant collision logs error-level and resolves deterministically', async () => {
    const teamId = `T_MULTI_LOG_${Date.now()}`
    const orgLow = await makeOrg('slack-collide-1')
    const orgHigh = await makeOrg('slack-collide-2')
    // Saved directly (bypassing the credential route's own conflict guard) to
    // simulate a collision that predates it — the scenario the lookup's own
    // defense-in-depth logging exists for.
    await saveSlackCredential(orgLow, teamId)
    await saveSlackCredential(orgHigh, teamId)

    const errorCalls: unknown[][] = []
    const restore = mock.method(console, 'error', (...args: unknown[]) => {
      errorCalls.push(args)
    })
    try {
      const first = await findSlackWorkspaceByTeamId(teamId)
      const second = await findSlackWorkspaceByTeamId(teamId)
      assert.ok(first)
      assert.ok(second)
      assert.equal(first!.organizationId, second!.organizationId, 'the same winner is picked on every call')
      // Deterministic order is organizationId ascending — the winner is
      // whichever of the two sorts first, not necessarily orgLow/orgHigh by
      // creation order.
      const expectedWinner = [orgLow, orgHigh].sort()[0]
      assert.equal(first!.organizationId, expectedWinner)

      assert.ok(errorCalls.length >= 2, 'each lookup logs the collision, not just the first')
      const logged = errorCalls.some((args) => String(args[0]).includes('claimed by more than one organization'))
      assert.ok(logged, 'the collision is logged at error level with an identifiable message')
    } finally {
      restore.mock.restore()
      await systemPrisma.integrationSecret.deleteMany({ where: { organizationId: { in: [orgLow, orgHigh] } } })
      await systemPrisma.organization.deleteMany({ where: { id: { in: [orgLow, orgHigh] } } })
    }
  })
}

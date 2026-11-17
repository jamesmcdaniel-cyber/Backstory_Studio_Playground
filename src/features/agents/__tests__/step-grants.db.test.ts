/**
 * Granted tool connections through the real loaders: a granted Nango provider
 * tool loads (and only that tool), and a Slack grant never switches on the
 * built-in Slack bot plane. See step-grants.test.ts for the mapping itself.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
const skip = TEST_DB ? false : 'TEST_DATABASE_URL is not set — the loaders need a real database'
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'ci-encryption-key'
  process.env.ENTITLEMENT_GATE = 'off'
  // Nango "configured", pointed at a closed port: resolution reads the
  // mirror table, and the cold-mirror resync on a miss fails fast.
  process.env.NANGO_API_KEY = 'test-nango-api-key'
  process.env.NANGO_HOST = 'http://127.0.0.1:9'
}

let prisma: any
let seeded: { organizationId: string; userId: string; cleanup: () => Promise<void> }

before(async () => {
  if (!TEST_DB) return
  ;({ prisma } = await import('@/lib/prisma'))
  const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
  seeded = await seedTestOrg(prisma)
  await prisma.nangoConnection.create({
    data: { organizationId: seeded.organizationId, userId: seeded.userId, connectionId: 'conn-github-grant', providerConfigKey: 'github', status: 'connected' },
  })
})

after(async () => {
  if (seeded) await seeded.cleanup()
})

test('a granted provider tool loads exactly that tool', { skip }, async () => {
  const { loadAgentToolGroups } = await import('../agent-tool-resolution')
  const groups = await loadAgentToolGroups({
    organizationId: seeded.organizationId,
    providers: [],
    ownerUserId: seeded.userId,
    grantedConnectionIds: ['nango:github_list_repositories'],
  })
  const nango = groups.filter((group) => group.plane === 'nango')
  assert.deepEqual(nango.map((group) => group.id), ['nango:github_list_repositories'])
  assert.ok(nango[0].client, 'the granted tool is callable')
  assert.equal(nango[0].credential?.actsAs, 'user')
})

test('a Slack provider tool grant is reported unavailable, and the Slack bot plane stays off', { skip }, async () => {
  const { loadAgentToolGroups } = await import('../agent-tool-resolution')
  const groups = await loadAgentToolGroups({
    organizationId: seeded.organizationId,
    providers: [],
    ownerUserId: seeded.userId,
    grantedConnectionIds: ['nango:slack_list_channels'],
  })
  // No Slack connection exists: the grant says so rather than vanishing…
  const slack = groups.find((group) => group.id === 'nango:slack')
  assert.ok(slack?.toolsError, 'the granted Slack tool is reported unavailable')
  // …and the built-in Slack plane (which would report its own missing bot
  // token if it had been selected) was never selected.
  assert.equal(groups.some((group) => group.id === 'native:slack'), false)
})

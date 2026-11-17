/**
 * What a template's setup checklist counts as connected: everything a run
 * could reach, not the 3-integration gate's narrow count. A workspace with
 * Backstory connected was told "Connect backstory"; one with a Databricks
 * credential saved was told "Connect databricks".
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
const skip = TEST_DB ? false : 'TEST_DATABASE_URL is not set'
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'ci-encryption-key'
  // Isolate from whatever the shell carries: only the seeded rows connect.
  delete process.env.PEOPLE_AI_SERVICE_CLIENT_ID
  delete process.env.PEOPLE_AI_SERVICE_CLIENT_SECRET
  delete process.env.BACKSTORY_MCP_URL
}

let prisma: any
let seeded: { organizationId: string; userId: string; cleanup: () => Promise<void> }

before(async () => {
  if (!TEST_DB) return
  ;({ prisma } = await import('@/lib/prisma'))
  const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
  seeded = await seedTestOrg(prisma)
})

after(async () => {
  if (seeded) await seeded.cleanup()
})

test('Backstory, a saved warehouse credential and a Nango connection all count as connected', { skip }, async () => {
  const { missingIntegrations } = await import('@/lib/templates/instantiate')
  const { encryptSecret } = await import('@/lib/crypto/secrets')
  const referenced = ['backstory', 'Databricks', 'nango:gmail', 'salesforce']
  assert.deepEqual(
    (await missingIntegrations(seeded.organizationId, seeded.userId, referenced)).sort(),
    ['backstory', 'databricks', 'gmail', 'salesforce'],
  )
  await prisma.peopleAiConnection.create({ data: { organizationId: seeded.organizationId, userId: seeded.userId, accessToken: 'enc-token' } })
  await prisma.httpCredential.create({
    data: {
      organizationId: seeded.organizationId, userId: seeded.userId, name: 'Databricks PAT', authType: 'bearer',
      allowedHost: 'dbc-1234.cloud.databricks.com', secretConfig: encryptSecret(JSON.stringify({ token: 't' })), status: 'verified',
    },
  })
  await prisma.nangoConnection.create({
    data: { organizationId: seeded.organizationId, userId: seeded.userId, connectionId: 'conn-gmail', providerConfigKey: 'google-mail', status: 'connected' },
  })
  assert.deepEqual(await missingIntegrations(seeded.organizationId, seeded.userId, referenced), ['salesforce'])
})

test('the gate count is unchanged: Backstory and warehouse credentials still do not count toward it', { skip }, async () => {
  const { listConnectedProviders } = await import('../connected')
  const keys = (await listConnectedProviders(seeded.organizationId, seeded.userId)).map((p) => p.key)
  assert.equal(keys.includes('backstory'), false)
  assert.equal(keys.includes('databricks'), false)
})

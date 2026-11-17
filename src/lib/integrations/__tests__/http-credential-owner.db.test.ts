/**
 * An agent's HTTP tools act as the person running the agent: their own saved
 * credential for the host first, then a legacy unowned one — never another
 * member's personal credential. credentialForHost used to take any credential
 * in the workspace for the host.
 */
import { test, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
const skip = TEST_DB ? false : 'TEST_DATABASE_URL is not set'
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'ci-encryption-key'
}

let prisma: any
let HttpToolClient: any
let encryptSecret: any
let seeded: { organizationId: string; userId: string; cleanup: () => Promise<void> }
const ids: Record<string, string> = {}

before(async () => {
  if (!TEST_DB) return
  ;({ prisma } = await import('@/lib/prisma'))
  ;({ HttpToolClient } = await import('../http'))
  ;({ encryptSecret } = await import('@/lib/crypto/secrets'))
  const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
  seeded = await seedTestOrg(prisma)
  ids.runner = seeded.userId
  ids.other = (await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: seeded.organizationId, isActive: true, name: 'Other Member' } })).id
  ids.third = (await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: seeded.organizationId, isActive: true } })).id
})

after(async () => {
  mock.restoreAll()
  if (seeded) await seeded.cleanup()
})

const save = (host: string, userId: string | null, token: string) =>
  prisma.httpCredential.create({
    data: {
      organizationId: seeded.organizationId, userId, name: `${host} ${token}`, authType: 'bearer', allowedHost: host,
      secretConfig: encryptSecret(JSON.stringify({ token })), status: 'verified', lastVerifiedAt: new Date(),
    },
  })

function captureAuth(): (string | undefined)[] {
  mock.restoreAll()
  const seen: (string | undefined)[] = []
  mock.method(globalThis, 'fetch', async (_url: any, init: any) => {
    seen.push((init?.headers ?? {}).authorization)
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
  return seen
}

test('the runner\'s own credential wins over an unowned one and over another member\'s', { skip }, async () => {
  const host = '203.0.113.21'
  // Another member's is the most recently verified — recency must not pick it.
  await save(host, null, 'shared-token')
  await save(host, ids.runner, 'runner-token')
  await save(host, ids.other, 'other-token')
  const seen = captureAuth()
  await new HttpToolClient(seeded.organizationId, [], ids.runner).executeTool('', 'request', { url: `https://${host}/v1` })
  assert.deepEqual(seen, ['Bearer runner-token'])
})

test('without one of their own, the runner gets the unowned credential, never another member\'s', { skip }, async () => {
  const host = '203.0.113.22'
  await save(host, ids.other, 'other-token')
  await save(host, null, 'shared-token')
  const seen = captureAuth()
  await new HttpToolClient(seeded.organizationId, [], ids.third).executeTool('', 'request', { url: `https://${host}/v1` })
  assert.deepEqual(seen, ['Bearer shared-token'])
})

test('only another member\'s personal credential exists: the call goes out unauthenticated', { skip }, async () => {
  const host = '203.0.113.23'
  await save(host, ids.other, 'other-token')
  const seen = captureAuth()
  const result: any = await new HttpToolClient(seeded.organizationId, [], ids.third).executeTool('', 'request', { url: `https://${host}/v1` })
  assert.deepEqual(seen, [undefined])
  assert.equal(result.authenticated, false)
})

test('an endpoint bound to another member\'s personal credential is refused with the fix', { skip }, async () => {
  const host = '203.0.113.24'
  const other = await save(host, ids.other, 'other-token')
  const seen = captureAuth()
  const endpoint = { id: 'e1', name: 'lookup', method: 'GET' as const, url: `https://${host}/v1/lookup`, credentialId: other.id }
  const client = new HttpToolClient(seeded.organizationId, [endpoint], ids.third)
  const { endpointToolName } = await import('../http-endpoints')
  await assert.rejects(
    () => client.executeTool('', endpointToolName(endpoint), {}),
    new RegExp(`This agent uses Other Member's personal credential for ${host.replace(/\./g, '\\.')}\\. Add your own credential`),
  )
  assert.deepEqual(seen, [])
  // The owner running the same agent still uses it.
  await new HttpToolClient(seeded.organizationId, [endpoint], ids.other).executeTool('', endpointToolName(endpoint), {})
  assert.deepEqual(seen, ['Bearer other-token'])
})

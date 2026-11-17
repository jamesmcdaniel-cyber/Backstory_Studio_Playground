/**
 * A shared flow's HTTP step goes out on the RUNNER's own credential.
 *
 * Run validation and the runtime used to check only the workspace, so member
 * B pressing Run on A's flow sent A's personal key, attributed to B. Now a
 * personal credential is usable by its owner alone (a legacy unowned one by
 * anyone); scheduled/webhook/poll runs act as the flow's owner, so the
 * owner's own credential keeps working there.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { enterTestTenant } from '@/lib/server/__tests__/test-tenant'

const TEST_DB = process.env.TEST_DATABASE_URL
const skip = TEST_DB ? false : 'TEST_DATABASE_URL is not set'
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'ci-encryption-key'
}

let prisma: any
let runFlowExecution: any
let resolveHttpCredential: any
let validateGraphForRun: any
let setSsrfResolver: any
let clearPins: any
const ids: Record<string, string> = {}
const realFetch = globalThis.fetch
const position = { x: 0, y: 0 }

const graphWith = (credentialId: string) => ({
  nodes: [
    { id: 'trigger', type: 'trigger', position, data: { trigger: { type: 'manual' } } },
    { id: 'call', type: 'http', position, data: { label: 'Call API', method: 'GET', url: 'https://api.example.com/v1/things', credentialId } },
  ],
  edges: [{ id: 'e1', source: 'trigger', target: 'call' }],
})

before(async () => {
  if (!TEST_DB) return
  ;({ prisma } = await import('@/lib/prisma'))
  ;({ runFlowExecution } = await import('../execute-flow'))
  ;({ resolveHttpCredential } = await import('../http-auth'))
  ;({ validateGraphForRun } = await import('@/lib/flows/run-validation'))
  const { encryptSecret } = await import('@/lib/crypto/secrets')
  const ssrf = await import('@/lib/net/ssrf')
  setSsrfResolver = ssrf.__setSsrfResolver
  clearPins = ssrf.clearPins
  setSsrfResolver(async () => [{ address: '93.184.216.34', family: 4 as const }])
  const org = await prisma.organization.create({ data: { name: 'CredOwner', slug: `cred-owner-${crypto.randomUUID()}` } })
  ids.org = org.id
  enterTestTenant(org.id)
  const owner = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: org.id, isActive: true, name: 'Ada Owner' } })
  const member = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: org.id, isActive: true, name: 'Ben Member' } })
  ids.owner = owner.id
  ids.member = member.id
  const credential = (userId: string | null, value: string) => prisma.httpCredential.create({
    data: {
      organizationId: org.id, userId, name: `api.example.com ${value}`, authType: 'header', allowedHost: 'api.example.com',
      secretConfig: encryptSecret(JSON.stringify({ name: 'x-api-key', value })), status: 'verified',
    },
  })
  ids.ownerCredential = (await credential(owner.id, 'owner-key')).id
  ids.unownedCredential = (await credential(null, 'shared-key')).id
  const flow = await prisma.flow.create({
    data: { name: 'Shared flow', organizationId: org.id, userId: owner.id, status: 'ACTIVE', visibility: 'shared', graph: graphWith(ids.ownerCredential), publishedGraph: graphWith(ids.ownerCredential) },
  })
  ids.flow = flow.id
})

after(async () => {
  if (!TEST_DB) return
  globalThis.fetch = realFetch
  setSsrfResolver(null)
  clearPins()
  await prisma.flowRunStep.deleteMany({ where: { run: { organizationId: ids.org } } })
  await prisma.flowRun.deleteMany({ where: { organizationId: ids.org } })
  await prisma.flow.deleteMany({ where: { organizationId: ids.org } })
  await prisma.httpCredential.deleteMany({ where: { organizationId: ids.org } })
  await prisma.user.deleteMany({ where: { organizationId: ids.org } })
  await prisma.organization.delete({ where: { id: ids.org } })
})

function captureKeys(): string[] {
  const keys: string[] = []
  globalThis.fetch = (async (_url: string, init: any) => {
    keys.push(String((init?.headers ?? {})['x-api-key'] ?? ''))
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return keys
}

test('run validation refuses another member\'s personal credential, naming the owner, host and fix', { skip }, async () => {
  const { validation } = await validateGraphForRun(graphWith(ids.ownerCredential), { organizationId: ids.org, userId: ids.member, flowId: ids.flow })
  const issue = validation.issues.find((entry: any) => entry.code === 'HTTP_CREDENTIAL_NOT_OWNED')
  assert.ok(issue, 'blocking issue raised')
  assert.equal(issue.level, 'error')
  assert.equal(issue.message, "Call API uses Ada Owner's personal credential for api.example.com. Add your own credential for api.example.com, or ask an admin to make it per-user.")
})

test('the owner, a publish acting for the owner, and an unowned credential all validate', { skip }, async () => {
  const asOwner = await validateGraphForRun(graphWith(ids.ownerCredential), { organizationId: ids.org, userId: ids.owner, flowId: ids.flow })
  assert.equal(asOwner.validation.issues.some((entry: any) => entry.code === 'HTTP_CREDENTIAL_NOT_OWNED'), false)
  const publishedForOwner = await validateGraphForRun(graphWith(ids.ownerCredential), { organizationId: ids.org, userId: ids.member, credentialUserId: ids.owner, flowId: ids.flow })
  assert.equal(publishedForOwner.validation.issues.some((entry: any) => entry.code === 'HTTP_CREDENTIAL_NOT_OWNED'), false)
  const unowned = await validateGraphForRun(graphWith(ids.unownedCredential), { organizationId: ids.org, userId: ids.member, flowId: ids.flow })
  assert.equal(unowned.validation.issues.some((entry: any) => entry.code === 'HTTP_CREDENTIAL_NOT_OWNED'), false)
})

test('a scheduled run acts as the flow owner and sends the owner\'s own key', { skip }, async () => {
  const keys = captureKeys()
  // What dispatch-tick enqueues for a due schedule: userId is the flow owner.
  const result = await runFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.owner, input: '', usePublished: true, trigger: { type: 'schedule' } })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(keys, ['owner-key'])
})

test('another member pressing Run never sends the owner\'s key', { skip }, async () => {
  const keys = captureKeys()
  await assert.rejects(
    () => runFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.member, input: '' }),
    /Ada Owner's personal credential for api\.example\.com/,
  )
  assert.deepEqual(keys, [])
})

test('the runtime enforces the same rule when validation is bypassed', { skip }, async () => {
  await assert.rejects(
    () => resolveHttpCredential(ids.ownerCredential, ids.org, { actorUserId: ids.member, consumer: 'flow.http_step', runnerOwned: true }),
    /^Error: This step uses Ada Owner's personal credential for api\.example\.com\. Add your own credential/,
  )
  const own = await resolveHttpCredential(ids.ownerCredential, ids.org, { actorUserId: ids.owner, runnerOwned: true })
  assert.equal(own.id, ids.ownerCredential)
  const unowned = await resolveHttpCredential(ids.unownedCredential, ids.org, { actorUserId: ids.member, runnerOwned: true })
  assert.equal(unowned.id, ids.unownedCredential)
  // Callers that keep their own ladder (the warehouse resolver) are unchanged.
  const legacy = await resolveHttpCredential(ids.ownerCredential, ids.org, { actorUserId: ids.member })
  assert.equal(legacy.id, ids.ownerCredential)
})

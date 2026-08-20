/**
 * Demo session lifecycle: the cookie is a verified claim, enter builds (or
 * reuses) the sandbox, exit deletes it. Handlers run for real through
 * withAuthenticatedApi via the injected-auth seam; the cookie crosses via the
 * session module's test seam (no browser here to carry Set-Cookie back).
 */
import { test, before, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
const skip = TEST_DB ? false : 'TEST_DATABASE_URL is not set — demo sessions need a real database'
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
}

let systemPrisma: any
let setTestAuthContext: any
let setTestDemoCookie: any
let resolveDemoOrganization: any
let ensureDemoWorkspace: any

before(async () => {
  if (!TEST_DB) return
  ;({ systemPrisma } = await import('@/lib/prisma'))
  ;({ setTestAuthContext } = await import('@/lib/server/auth'))
  ;({ setTestDemoCookie, resolveDemoOrganization } = await import('../session'))
  ;({ ensureDemoWorkspace } = await import('../snapshot'))
})

afterEach(() => {
  if (!TEST_DB) return
  setTestAuthContext(null)
  setTestDemoCookie(null)
})

async function seedOrgAndUser() {
  const org = await systemPrisma.organization.create({
    data: { name: 'Session Real Co', slug: `demo-session-${crypto.randomUUID()}`, kind: 'customer' },
  })
  const user = await systemPrisma.user.create({
    data: {
      supabaseId: crypto.randomUUID(),
      email: `sess-${crypto.randomUUID()}@example.com`,
      organizationId: org.id,
      isActive: true,
      role: 'ADMIN',
    },
  })
  return { org, user }
}

function injectAuth(user: any, organizationId: string) {
  const permissions = new Set(['flow.read', 'flow.write'])
  setTestAuthContext({
    user: { id: user.supabaseId },
    dbUser: { ...user, organization: null },
    userId: user.supabaseId,
    organizationId,
    permissions,
    can: () => true,
    features: new Set(),
    hasFeature: () => false,
  })
}

const rq = (path: string) => new NextRequest(new URL(`http://test${path}`), { method: 'POST' })

test('a cookie naming someone else’s demo org resolves to null', { skip }, async () => {
  const a = await seedOrgAndUser()
  const b = await seedOrgAndUser()
  const { demoOrgId } = await ensureDemoWorkspace(a.org.id, a.user.id)
  setTestDemoCookie(demoOrgId)
  assert.equal(await resolveDemoOrganization(b.user.id), null)
  assert.equal(await resolveDemoOrganization(a.user.id), demoOrgId)
})

test('a stale cookie after teardown resolves to null, quietly', { skip }, async () => {
  setTestDemoCookie(crypto.randomUUID())
  const { user } = await seedOrgAndUser()
  assert.equal(await resolveDemoOrganization(user.id), null)
})

test('a cookie naming a NON-demo org resolves to null', { skip }, async () => {
  const { org, user } = await seedOrgAndUser()
  setTestDemoCookie(org.id)
  assert.equal(await resolveDemoOrganization(user.id), null)
})

test('enter builds the sandbox and sets the cookie; re-enter reuses it', { skip }, async () => {
  const { org, user } = await seedOrgAndUser()
  injectAuth(user, org.id)
  const { POST } = await import('@/app/api/demo/enter/route')
  const first = await POST(rq('/api/demo/enter'))
  assert.equal(first.status, 200)
  const { demoOrgId } = await first.json()
  assert.ok(first.headers.get('set-cookie')?.includes(`backstory-demo=${demoOrgId}`))
  const demoOrg = await systemPrisma.organization.findUnique({ where: { id: demoOrgId } })
  assert.equal(demoOrg.kind, 'demo')
  assert.equal(demoOrg.demoOwnerUserId, user.id)
  const second = await POST(rq('/api/demo/enter'))
  assert.equal((await second.json()).demoOrgId, demoOrgId)
})

test('exit tears the sandbox down and clears the cookie', { skip }, async () => {
  const { org, user } = await seedOrgAndUser()
  const { demoOrgId } = await ensureDemoWorkspace(org.id, user.id)
  injectAuth(user, org.id)
  setTestDemoCookie(demoOrgId)
  const { POST } = await import('@/app/api/demo/exit/route')
  const response = await POST(rq('/api/demo/exit'))
  assert.equal(response.status, 200)
  assert.match(response.headers.get('set-cookie') ?? '', /backstory-demo=;/)
  assert.equal(await systemPrisma.organization.findUnique({ where: { id: demoOrgId } }), null)
  // The REAL workspace is untouched.
  assert.ok(await systemPrisma.organization.findUnique({ where: { id: org.id } }))
})

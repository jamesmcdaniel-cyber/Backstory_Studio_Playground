import { test, afterEach, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'
import { setTestAuthContext, type AuthContext } from '@/lib/server/auth'
import { resolvePermissions } from '@/lib/authz/permissions'
import { DEFAULT_FEATURES } from '@/lib/authz/features'

/**
 * The workspace AI switch is the only writer of a column the whole platform
 * refuses work on. Two things must hold: an ordinary member cannot flip it, and
 * an administrator who flips it actually changes what the enforcement code
 * reads (a PATCH that returns success while the runtime keeps sending is the
 * failure this endpoint exists to prevent).
 */

const TEST_DB = process.env.TEST_DATABASE_URL
// The auth seam needs a non-production NODE_ENV and TEST_DATABASE_URL; the
// permission cases never reach Postgres, so a dummy suffices for those.
process.env.TEST_DATABASE_URL ??= 'postgresql://unused/ai-policy-route'

function contextFor(role: 'USER' | 'ADMIN' | 'VIEWER', organizationId: string): AuthContext {
  const permissions = resolvePermissions({ role, platformRole: null }, { kind: 'customer' })
  return {
    organizationId,
    userId: 'user-1',
    dbUser: { id: 'user-1', role, platformRole: null } as never,
    user: { id: 'sb-1' } as never,
    permissions,
    can: (permission) => permissions.has(permission),
    features: DEFAULT_FEATURES,
    hasFeature: (feature) => DEFAULT_FEATURES.has(feature),
  }
}

const url = 'http://test/api/organizations/ai-policy'
const get = () => new NextRequest(new URL(url))
const patch = (body: unknown) =>
  new NextRequest(new URL(url), { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

afterEach(() => setTestAuthContext(null))

for (const role of ['USER', 'VIEWER'] as const) {
  test(`a ${role} cannot read or change the workspace AI switch`, async () => {
    setTestAuthContext(contextFor(role, '00000000-0000-4000-8000-000000000001'))
    const { GET, PATCH } = await import('../route')

    for (const response of [await GET(get()), await PATCH(patch({ aiEgressPolicy: 'blocked' }))]) {
      const body = await response.json()
      assert.equal(response.status, 403, JSON.stringify(body))
      assert.equal(body.code, 'PERMISSION_DENIED')
      assert.equal(body.detail?.required, 'security.manage')
    }
  })
}

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let loadAiEgressPolicy: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ loadAiEgressPolicy } = await import('@/lib/usage/ai-guard'))
    const org = await prisma.organization.create({
      data: { name: 'AI policy route', slug: `ai-policy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    })
    ids.org = org.id
    const user = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: org.id } })
    ids.user = user.id
  })

  after(async () => {
    if (!ids.org) return
    await prisma.auditEvent.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.delete({ where: { id: ids.org } })
  })

  const asAdmin = () => {
    const ctx = contextFor('ADMIN', ids.org)
    setTestAuthContext({ ...ctx, userId: ids.user, dbUser: { id: ids.user, role: 'ADMIN', platformRole: null } as never })
  }

  test('a new workspace reads as allowed', async () => {
    asAdmin()
    const { GET } = await import('../route')
    const body = await (await GET(get())).json()
    assert.equal(body.success, true)
    assert.equal(body.aiEgressPolicy, 'allowed')
  })

  test('an administrator switching AI off changes what the enforcement code reads', async () => {
    asAdmin()
    const { GET, PATCH } = await import('../route')

    const response = await PATCH(patch({ aiEgressPolicy: 'blocked' }))
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.aiEgressPolicy, 'blocked')

    // The property that matters: the gate the runtimes call now says blocked.
    assert.equal(await loadAiEgressPolicy(ids.org), 'blocked')
    assert.equal((await (await GET(get())).json()).aiEgressPolicy, 'blocked')

    const audited = await prisma.auditEvent.findFirst({
      where: { organizationId: ids.org, action: 'ai.egress_policy_changed' },
    })
    assert.ok(audited, 'a workspace-wide policy change is recorded with who made it')
    assert.equal(audited.actorUserId, ids.user)
    assert.equal((audited.detail as any).aiEgressPolicy, 'blocked')
  })

  test('switching it back on is equally effective and equally recorded', async () => {
    asAdmin()
    const { PATCH } = await import('../route')

    assert.equal((await (await PATCH(patch({ aiEgressPolicy: 'allowed' }))).json()).aiEgressPolicy, 'allowed')
    assert.equal(await loadAiEgressPolicy(ids.org), 'allowed')
    assert.equal(
      await prisma.auditEvent.count({ where: { organizationId: ids.org, action: 'ai.egress_policy_changed' } }),
      2,
      'both directions are auditable, not just the restrictive one',
    )
  })

  test('an unknown value is rejected rather than silently stored', async () => {
    asAdmin()
    const { PATCH } = await import('../route')
    const response = await PATCH(patch({ aiEgressPolicy: 'off' }))
    assert.equal(response.status, 400)
    // The stored value is untouched — a typo must not become a silent opt-out.
    assert.equal(await loadAiEgressPolicy(ids.org), 'allowed')
  })
}

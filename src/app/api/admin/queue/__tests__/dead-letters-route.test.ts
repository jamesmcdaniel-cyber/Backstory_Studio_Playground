import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { setTestAuthContext, type AuthContext } from '@/lib/server/auth'
import { resolvePermissions } from '@/lib/authz/permissions'
import { DEFAULT_FEATURES } from '@/lib/authz/features'

/**
 * The dead-letter operator API hands back other workspaces' raw job payloads
 * and can re-run their jobs. This suite pins the two gates that keep it out of
 * everyone else's hands, and does so WITHOUT Redis: every case here is refused
 * (or fails schema validation) strictly before the handler body — which is the
 * only place a queue connection is ever opened.
 */

// The auth seam requires a non-production NODE_ENV and TEST_DATABASE_URL. This
// suite never reaches Postgres, so a dummy value is enough (matching
// src/lib/server/__tests__/permission-gate.test.ts).
process.env.TEST_DATABASE_URL ??= 'postgresql://unused/dead-letters-route'

function contextFor(role: 'USER' | 'ADMIN' | 'VIEWER', orgKind: string, platformRole: string | null): AuthContext {
  const permissions = resolvePermissions({ role, platformRole }, { kind: orgKind })
  return {
    organizationId: 'org-1',
    userId: 'user-1',
    dbUser: { id: 'user-1', role, platformRole } as never,
    user: { id: 'sb-1' } as never,
    permissions,
    can: (permission) => permissions.has(permission),
    features: DEFAULT_FEATURES,
    hasFeature: (feature) => DEFAULT_FEATURES.has(feature),
  }
}

const get = () => new NextRequest(new URL('http://test/api/admin/queue/dead-letters'))
const post = (body: unknown) =>
  new NextRequest(new URL('http://test/api/admin/queue/dead-letters'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

afterEach(() => {
  setTestAuthContext(null)
  delete process.env.APP_EDITION
})

const nonOperators: [string, AuthContext][] = [
  ['a customer workspace member', contextFor('USER', 'customer', null)],
  // The case worth naming: being ADMIN of your own workspace is not operator
  // privilege. platform.administer reaches across every tenant.
  ['a customer workspace ADMIN', contextFor('ADMIN', 'customer', null)],
  // A catalogue reviewer in a partner org holds catalogue.review but NOT
  // platform.administer — the same split /api/admin/costs relies on.
  ['a partner-org reviewer', contextFor('ADMIN', 'partner', 'reviewer')],
]

for (const [label, ctx] of nonOperators) {
  test(`GET is denied to ${label}`, async () => {
    setTestAuthContext(ctx)
    const { GET } = await import('../dead-letters/route')

    const response = await GET(get())
    const body = await response.json()

    assert.equal(response.status, 403, JSON.stringify(body))
    assert.equal(body.code, 'PERMISSION_DENIED')
    assert.equal(body.detail?.required, 'platform.administer')
  })

  test(`POST replay is denied to ${label}`, async () => {
    setTestAuthContext(ctx)
    const { POST } = await import('../dead-letters/route')

    const response = await POST(post({ action: 'replay', id: 'agent-dead-letter:1', confirm: true }))
    const body = await response.json()

    assert.equal(response.status, 403, JSON.stringify(body))
    assert.equal(body.code, 'PERMISSION_DENIED')
  })
}

test('an internal-org reviewer holds the permission the route requires', () => {
  // The positive half of the gate: without this, a 403-only suite would still
  // pass if the route were gated on a permission literally nobody can hold.
  assert.equal(contextFor('ADMIN', 'internal', 'reviewer').can('platform.administer'), true)
})

test('the customer edition answers 404, before auth is even consulted', async () => {
  process.env.APP_EDITION = 'customer'
  setTestAuthContext(contextFor('ADMIN', 'internal', 'reviewer'))
  const { GET } = await import('../dead-letters/route')

  const response = await GET(get())

  assert.equal(response.status, 404)
})

test('an operator POST without explicit confirmation is refused', async () => {
  // Destructive-by-default protection, asserted at the edge: schema validation
  // rejects this before the handler opens a queue connection.
  setTestAuthContext(contextFor('ADMIN', 'internal', 'reviewer'))
  const { POST } = await import('../dead-letters/route')

  const response = await POST(post({ action: 'drop', id: 'agent-dead-letter:1' }))

  assert.equal(response.status, 400, JSON.stringify(await response.json()))
})

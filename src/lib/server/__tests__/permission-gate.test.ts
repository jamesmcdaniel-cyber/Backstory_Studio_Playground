import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { withAuthenticatedApi } from '../api-handler'
import { setTestAuthContext } from '../auth'
import { resolvePermissions } from '@/lib/authz/permissions'
import type { AuthContext } from '../auth'

function contextFor(role: 'USER' | 'ADMIN' | 'VIEWER', orgKind: string, platformRole: string | null): AuthContext {
  const permissions = resolvePermissions({ role, platformRole }, { kind: orgKind })
  return {
    organizationId: 'org-1',
    userId: 'user-1',
    dbUser: { id: 'user-1', role, platformRole } as never,
    user: { id: 'sb-1' } as never,
    permissions,
    can: (permission) => permissions.has(permission),
  }
}

// The seam requires a non-production NODE_ENV and TEST_DATABASE_URL; this
// suite drives the wrapper only, so a dummy value is enough.
process.env.TEST_DATABASE_URL ??= 'postgresql://unused/permission-gate'

const request = () => new NextRequest(new URL('http://test/api/thing'))

test('a handler with no declared permission still runs', async () => {
  setTestAuthContext(contextFor('USER', 'customer', null))
  const handler = withAuthenticatedApi(async () => ({ success: true }))
  assert.equal((await handler(request())).status, 200)
  setTestAuthContext(null)
})

test('a satisfied permission lets the handler run', async () => {
  setTestAuthContext(contextFor('USER', 'customer', null))
  const handler = withAuthenticatedApi(async () => ({ success: true }), { permission: 'flow.write' })
  assert.equal((await handler(request())).status, 200)
  setTestAuthContext(null)
})

test('an unsatisfied permission 403s with PERMISSION_DENIED before the handler runs', async () => {
  setTestAuthContext(contextFor('ADMIN', 'customer', null))
  let ran = false
  const handler = withAuthenticatedApi(
    async () => { ran = true; return { success: true } },
    { permission: 'catalogue.review' },
  )
  const response = await handler(request())
  assert.equal(response.status, 403)
  const body = await response.json()
  assert.equal(body.code, 'PERMISSION_DENIED')
  assert.equal(body.detail?.required, 'catalogue.review')
  assert.equal(ran, false, 'the handler must not run when the gate rejects')
  setTestAuthContext(null)
})

test('a reviewer in an internal org passes the same gate', async () => {
  setTestAuthContext(contextFor('ADMIN', 'internal', 'reviewer'))
  const handler = withAuthenticatedApi(async () => ({ success: true }), { permission: 'catalogue.review' })
  assert.equal((await handler(request())).status, 200)
  setTestAuthContext(null)
})

test('auth.can mirrors the resolved set', () => {
  const ctx = contextFor('USER', 'partner', null)
  assert.equal(ctx.can('template.submit'), true)
  assert.equal(ctx.can('catalogue.publish'), false)
})

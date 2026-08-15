import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTestAuthContext, requireAuthContext } from '../auth'
import type { Permission } from '@/lib/authz/permissions'
import type { Feature } from '@/lib/authz/features'

// This suite is about the seam's gating, not authorization — an empty
// permission set keeps the contexts minimal without weakening what is tested.
const noPermissions = new Set<Permission>()
// Same rationale for features: this suite tests the seam, not entitlement.
const noFeatures = new Set<Feature>()
const grants = {
  permissions: noPermissions,
  can: () => false,
  features: noFeatures,
  hasFeature: () => false,
}

test('setTestAuthContext override is ignored in production', async () => {
  const prev = process.env.NODE_ENV
  const prevDb = process.env.TEST_DATABASE_URL
  ;(process.env as Record<string, string>).NODE_ENV = 'production'
  process.env.TEST_DATABASE_URL = 'postgres://x'
  setTestAuthContext({ organizationId: 'o', userId: 'u', dbUser: { id: 'u' } as never, user: { id: 'u' } as never, ...grants })
  // In production the override must NOT short-circuit — requireAuthContext must
  // fall through to the real (here, unconfigured) Supabase path and reject.
  await assert.rejects(() => requireAuthContext())
  setTestAuthContext(null)
  ;(process.env as Record<string, string>).NODE_ENV = prev as string
  if (prevDb === undefined) delete process.env.TEST_DATABASE_URL
  else process.env.TEST_DATABASE_URL = prevDb
})

test('setTestAuthContext override is honored under test gating', async () => {
  const prevDb = process.env.TEST_DATABASE_URL
  process.env.TEST_DATABASE_URL = 'postgres://x' // NODE_ENV is undefined under tsx --test in this repo; gate is NODE_ENV !== 'production'
  const ctx = { organizationId: 'o1', userId: 'u1', dbUser: { id: 'u1' } as never, user: { id: 'u1' } as never, ...grants }
  setTestAuthContext(ctx)
  const resolved = await requireAuthContext()
  assert.equal(resolved.organizationId, 'o1')
  assert.equal(resolved.userId, 'u1')
  setTestAuthContext(null)
  if (prevDb === undefined) delete process.env.TEST_DATABASE_URL
  else process.env.TEST_DATABASE_URL = prevDb
})

test('with no override, requireAuthContext ignores the seam entirely', async () => {
  setTestAuthContext(null)
  await assert.rejects(() => requireAuthContext()) // no Supabase configured in unit env
})

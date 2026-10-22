import test from 'node:test'
import assert from 'node:assert/strict'
import { nextAuthContextStep, type AuthSeed } from '../auth-context-state'

/**
 * The shell used to learn the caller's permissions only after the browser's
 * Supabase session resolved AND a follow-up /api/auth/context round trip, so
 * permission-gated nav (Admin, Reviews) appeared a beat after everything else.
 * The layout now seeds the context from the server render; these pin when that
 * seed is kept, when it is dropped, and when a fetch is still needed.
 */

const seed: AuthSeed = {
  authUserId: 'auth-1',
  context: { userId: 'db-1', organizationId: 'org-1', role: 'OWNER', permissions: ['platform.administer'] },
}

test('the server seed paints the first frame, before the browser session resolves', () => {
  const step = nextAuthContextStep({ seed, cached: null, sessionLoading: true, sessionUserId: null })
  assert.deepEqual(step, { context: seed.context, fetch: false })
})

test('a resolved session for the seeded user keeps the seed and makes no request', () => {
  const step = nextAuthContextStep({ seed, cached: null, sessionLoading: false, sessionUserId: 'auth-1' })
  assert.deepEqual(step, { context: seed.context, fetch: false })
})

test('signing out drops the context', () => {
  const step = nextAuthContextStep({ seed, cached: null, sessionLoading: false, sessionUserId: null })
  assert.deepEqual(step, { context: null, fetch: false })
})

test('a different user than the seed was rendered for fetches their own context', () => {
  const step = nextAuthContextStep({ seed, cached: null, sessionLoading: false, sessionUserId: 'auth-2' })
  assert.deepEqual(step, { context: null, fetch: true })
})

test('a context already fetched for this user is shared, not fetched again', () => {
  const cached = { authUserId: 'auth-2', context: { ...seed.context, userId: 'db-2' } }
  const step = nextAuthContextStep({ seed, cached, sessionLoading: false, sessionUserId: 'auth-2' })
  assert.deepEqual(step, { context: cached.context, fetch: false })
})

test('with no seed (a public page, or the seed failed) a signed-in session fetches', () => {
  assert.deepEqual(nextAuthContextStep({ seed: null, cached: null, sessionLoading: true, sessionUserId: null }), { context: null, fetch: false })
  assert.deepEqual(nextAuthContextStep({ seed: null, cached: null, sessionLoading: false, sessionUserId: 'auth-1' }), { context: null, fetch: true })
})

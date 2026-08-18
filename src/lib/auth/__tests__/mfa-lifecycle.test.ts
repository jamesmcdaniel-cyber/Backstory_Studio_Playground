import { test } from 'node:test'
import assert from 'node:assert/strict'
import { removalWouldLockOut, splitTotpFactors } from '../mfa-factors'
import { mfaVerifiedAt, stepUpSatisfied, STEP_UP_MAX_AGE_MS } from '../mfa-session'

/**
 * The pure half of MFA recovery: which factors are debris, when a removal would
 * strand someone, and whether a session has recently proven possession. Every
 * refusal in /api/auth/mfa/factors is one of these three answers.
 */

const totp = (id: string, status: string) => ({ id, factor_type: 'totp', status })

test('an unverified factor is debris, not a second factor', () => {
  const { verified, stale } = splitTotpFactors([
    totp('a', 'verified'),
    totp('b', 'unverified'),
    { id: 'c', factor_type: 'phone', status: 'verified' },
  ])
  assert.deepEqual(verified.map((f) => f.id), ['a'])
  assert.deepEqual(stale.map((f) => f.id), ['b'], 'non-TOTP factors are neither')
})

test('removal is unrestricted when the policy does not require MFA', () => {
  assert.equal(
    removalWouldLockOut({
      policyRequired: false,
      factors: [totp('a', 'verified')],
      removedId: 'a',
      methods: ['password'],
      email: 'someone@example.com',
    }),
    false,
  )
})

test('removing the ONLY verified factor under a required policy is a lockout', () => {
  assert.equal(
    removalWouldLockOut({
      policyRequired: true,
      factors: [totp('a', 'verified'), totp('b', 'unverified')],
      removedId: 'a',
      methods: ['password'],
      email: 'someone@example.com',
    }),
    true,
    'the unverified factor cannot satisfy the policy, so it does not count as the second one',
  )
})

test('a second verified factor makes the removal safe', () => {
  assert.equal(
    removalWouldLockOut({
      policyRequired: true,
      factors: [totp('a', 'verified'), totp('b', 'verified')],
      removedId: 'a',
      methods: ['password'],
      email: 'someone@example.com',
    }),
    false,
  )
})

test('an enterprise-brokered identity satisfies the policy without any factor', () => {
  assert.equal(
    removalWouldLockOut({
      policyRequired: true,
      factors: [totp('a', 'verified')],
      removedId: 'a',
      methods: ['sso/saml'],
      email: 'someone@people.ai',
    }),
    false,
    'Okta enforces its own MFA, so an SSO session is not stranded by losing TOTP',
  )
})

test('removing debris is never a lockout', () => {
  assert.equal(
    removalWouldLockOut({
      policyRequired: true,
      factors: [totp('a', 'verified'), totp('b', 'unverified')],
      removedId: 'b',
      methods: ['password'],
      email: 'someone@example.com',
    }),
    false,
  )
})

test('the MFA timestamp is read off the amr claim, in seconds', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0)
  const at = mfaVerifiedAt(
    [{ method: 'password', timestamp: Math.floor(now / 1000) - 7200 }, { method: 'mfa', timestamp: Math.floor(now / 1000) - 60 }],
    now,
  )
  assert.ok(at)
  assert.equal(now - at.getTime(), 60_000)
})

test('an amr claim with no MFA leg has no timestamp', () => {
  assert.equal(mfaVerifiedAt([{ method: 'password', timestamp: 1 }]), null)
  assert.equal(mfaVerifiedAt(undefined), null)
})

test('step-up requires aal2 whatever the timestamps say', () => {
  const now = Date.now()
  assert.equal(stepUpSatisfied({ assuranceLevel: 'aal1', methods: ['password'], verifiedAt: new Date(now) }, now), false)
  assert.equal(stepUpSatisfied({ assuranceLevel: null, methods: [], verifiedAt: null }, now), false)
})

test('an aal2 session goes stale once the verification ages out', () => {
  const now = Date.now()
  const fresh = { assuranceLevel: 'aal2', methods: ['mfa'], verifiedAt: new Date(now - 60_000) }
  const stale = { assuranceLevel: 'aal2', methods: ['mfa'], verifiedAt: new Date(now - STEP_UP_MAX_AGE_MS - 1000) }
  assert.equal(stepUpSatisfied(fresh, now), true)
  assert.equal(stepUpSatisfied(stale, now), false)
})

test('aal2 with no timestamp available is accepted, deliberately', () => {
  // getClaims can fall back to getUser, which exposes no amr at all. Refusing
  // there would make removal impossible rather than safer — see mfa-session.ts.
  assert.equal(stepUpSatisfied({ assuranceLevel: 'aal2', methods: [], verifiedAt: null }), true)
})

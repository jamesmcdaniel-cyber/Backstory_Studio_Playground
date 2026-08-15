import { test } from 'node:test'
import assert from 'node:assert/strict'

import { evaluateSsoRequirement, normalizeEnforcement } from '../identity-providers'
import type { ResolvedIdentityProvider } from '../identity-providers'

/**
 * Every test here is about a lockout.
 *
 * The failure mode for SSO enforcement is not "an attacker gets in" — it is
 * "the customer cannot get in, including the admin who would turn the setting
 * off". That failure has no in-product recovery, so each rule below chooses the
 * side that keeps a legitimate workspace reachable.
 */

const provider = (over: Partial<ResolvedIdentityProvider> = {}): ResolvedIdentityProvider => ({
  id: 'idp_1',
  organizationId: 'org_1',
  name: 'Acme Okta',
  protocol: 'saml',
  supabaseSsoId: 'sso_abc',
  status: 'active',
  enforcement: 'required',
  ...over,
})

test('no configured provider means no requirement', () => {
  assert.deepEqual(evaluateSsoRequirement({ provider: null, methods: ['password'] }), { allowed: true })
})

test('an optional workspace admits any method', () => {
  const decision = evaluateSsoRequirement({
    provider: provider({ enforcement: 'optional' }),
    methods: ['password'],
  })
  assert.equal(decision.allowed, true)
})

test('a required workspace refuses a password sign-in', () => {
  const decision = evaluateSsoRequirement({ provider: provider(), methods: ['password'] })

  assert.equal(decision.allowed, false)
  assert.equal(decision.allowed === false && decision.reason, 'sso_required')
  // The message has to name the provider: "SSO required" leaves the person
  // staring at a login page with no idea which button is theirs.
  assert.match(decision.allowed === false ? decision.message : '', /Acme Okta/)
})

test('a required workspace admits an SSO-brokered identity', () => {
  const decision = evaluateSsoRequirement({ provider: provider(), methods: ['sso/saml'] })
  assert.equal(decision.allowed, true)
})

test('a PENDING provider cannot be required — that is the setup window', () => {
  // Enforcing against a half-provisioned connection locks the workspace out at
  // exactly the moment they are configuring it, and the admin who could turn
  // it off is locked out too.
  const decision = evaluateSsoRequirement({
    provider: provider({ status: 'pending', supabaseSsoId: null }),
    methods: ['password'],
  })
  assert.equal(decision.allowed, true)
})

test('a provider with no Supabase connection cannot be required', () => {
  // The row can exist before the protocol connection does. Requiring an IdP
  // that cannot actually broker a sign-in is an unconditional lockout.
  const decision = evaluateSsoRequirement({
    provider: provider({ supabaseSsoId: null }),
    methods: ['password'],
  })
  assert.equal(decision.allowed, true)
})

test('a disabled provider cannot be required', () => {
  const decision = evaluateSsoRequirement({
    provider: provider({ status: 'disabled' }),
    methods: ['password'],
  })
  assert.equal(decision.allowed, true)
})

test('enforcement parsing fails OPEN on an unrecognised value', () => {
  // Uniquely in this codebase, and deliberately. Failing closed on a typo or a
  // future enum value locks a workspace out of its own account with no way back
  // in through the product — a worse outcome than the risk it would avert.
  assert.equal(normalizeEnforcement('required'), 'required')
  assert.equal(normalizeEnforcement('optional'), 'optional')
  assert.equal(normalizeEnforcement('REQUIRED'), 'optional', 'only the exact value enforces')
  assert.equal(normalizeEnforcement('mandatory'), 'optional')
  assert.equal(normalizeEnforcement(null), 'optional')
  assert.equal(normalizeEnforcement(undefined), 'optional')
})

test('SSO detection is delegated, not redefined', () => {
  // enterprise-policy.ts already owns "what counts as an enterprise identity".
  // A second definition here would drift, and the two would disagree about
  // Google-federated company domains.
  for (const method of ['sso', 'saml', 'sso/saml', 'sso:uuid-here']) {
    assert.equal(
      evaluateSsoRequirement({ provider: provider(), methods: [method] }).allowed,
      true,
      `${method} should be recognised as enterprise`,
    )
  }
})

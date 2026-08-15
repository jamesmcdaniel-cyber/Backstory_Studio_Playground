import test from 'node:test'
import assert from 'node:assert/strict'
import { amrMethods, emailDomain, isEnterpriseIdentity, satisfiesMfaPolicy } from '@/lib/auth/enterprise-policy'

test('workspace MFA fails closed unless the session is AAL2', () => {
  assert.equal(satisfiesMfaPolicy('required', 'aal1'), false)
  assert.equal(satisfiesMfaPolicy('required', 'aal2'), true)
  assert.equal(satisfiesMfaPolicy('optional', null), true)
})

test('an IdP-brokered session satisfies required MFA — Okta enforces the second factor', () => {
  assert.equal(satisfiesMfaPolicy('required', 'aal1', ['sso/saml']), true)
  assert.equal(satisfiesMfaPolicy('required', null, ['password', 'saml']), true)
  // Social OAuth alone is not enterprise identity: no IdP policy stands behind it.
  assert.equal(satisfiesMfaPolicy('required', 'aal1', ['oauth']), false)
  assert.equal(satisfiesMfaPolicy('required', 'aal1', ['password']), false)
  assert.equal(satisfiesMfaPolicy('required', 'aal1', []), false)
})

test('company-domain Google OAuth counts as Okta-verified; other domains and passwords do not', () => {
  // The company Workspaces federate authentication to Okta, so a Google
  // session for a company address already passed Okta MFA to exist.
  assert.equal(satisfiesMfaPolicy('required', 'aal1', ['oauth'], 'james.mcdaniel@people.ai'), true)
  assert.equal(satisfiesMfaPolicy('required', 'aal1', ['oauth'], 'someone@backstory.ai'), true)
  // Unknown domain: a Google account proves nothing about IdP policy.
  assert.equal(satisfiesMfaPolicy('required', 'aal1', ['oauth'], 'someone@customer.com'), false)
  // A password session for a company address never touched Okta.
  assert.equal(satisfiesMfaPolicy('required', 'aal1', ['password'], 'james.mcdaniel@people.ai'), false)
  // Lookalike domains do not qualify.
  assert.equal(satisfiesMfaPolicy('required', 'aal1', ['oauth'], 'a@people.ai.attacker.tld'), false)
})

test('enterprise identity and domains normalize safely', () => {
  assert.equal(emailDomain(' User@Example.COM '), 'example.com')
  assert.equal(emailDomain('invalid'), null)
  assert.equal(isEnterpriseIdentity(['password', 'saml']), true)
  assert.equal(isEnterpriseIdentity(['password']), false)
})

test('only IdP-brokered identities satisfy SSO enforcement', () => {
  // Supabase marks SAML sign-ins 'sso/saml' in amr and 'sso:<uuid>' as provider.
  assert.equal(isEnterpriseIdentity(['sso/saml']), true)
  assert.equal(isEnterpriseIdentity(['sso:1c5a95f4-0000-0000-0000-000000000000']), true)
  // Social OAuth is NOT enterprise — "Continue with Google" must not bypass Okta.
  assert.equal(isEnterpriseIdentity(['google']), false)
  assert.equal(isEnterpriseIdentity(['azure']), false)
  assert.equal(isEnterpriseIdentity(['oauth']), false)
})

test('amrMethods tolerates string and object entries and junk', () => {
  assert.deepEqual(amrMethods([{ method: 'sso/saml', timestamp: 1 }, 'password', { bogus: true }, 7]), ['sso/saml', 'password'])
  assert.deepEqual(amrMethods(undefined), [])
  assert.deepEqual(amrMethods('nope'), [])
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { emailDomain, isEnterpriseIdentity, satisfiesMfaPolicy } from '@/lib/auth/enterprise-policy'

test('workspace MFA fails closed unless the session is AAL2', () => {
  assert.equal(satisfiesMfaPolicy('required', 'aal1'), false)
  assert.equal(satisfiesMfaPolicy('required', 'aal2'), true)
  assert.equal(satisfiesMfaPolicy('optional', null), true)
})

test('enterprise identity and domains normalize safely', () => {
  assert.equal(emailDomain(' User@Example.COM '), 'example.com')
  assert.equal(emailDomain('invalid'), null)
  assert.equal(isEnterpriseIdentity(['password', 'saml']), true)
  assert.equal(isEnterpriseIdentity(['password']), false)
})

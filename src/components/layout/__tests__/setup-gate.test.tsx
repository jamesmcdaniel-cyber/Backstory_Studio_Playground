import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSetupNavigation } from '../setup-gate'

test('a healthy connected session renders the app', () => {
  assert.equal(resolveSetupNavigation({ success: true, backstoryConnected: true }), null)
})

test('a session without a Backstory connection goes to /connect', () => {
  assert.equal(resolveSetupNavigation({ success: true, backstoryConnected: false }), '/connect')
})

test('SSO_REQUIRED routes to the SSO-primed login screen', () => {
  assert.equal(resolveSetupNavigation({ success: false, code: 'SSO_REQUIRED' }), '/auth/sso-required')
})

test('MFA_REQUIRED routes to enrollment instead of failing open', () => {
  // The regression this pins: a privileged account without a second factor got
  // 403 MFA_REQUIRED from every API — setup/status included — and the gate
  // fell into its fail-open branch, rendering a dead shell of failed requests
  // with no way to discover the fix.
  assert.equal(resolveSetupNavigation({ success: false, code: 'MFA_REQUIRED' }), '/auth/mfa')
})

test('transient failures still fail open so an outage does not lock the product', () => {
  assert.equal(resolveSetupNavigation({ success: false, code: 'INTERNAL' }), null)
  assert.equal(resolveSetupNavigation(null), null)
  assert.equal(resolveSetupNavigation(undefined), null)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safeReturnToPath, withOfflineAccess } from '../oauth-authcode'

test('safeReturnToPath accepts plain same-origin paths', () => {
  assert.equal(safeReturnToPath('/connect'), '/connect')
  assert.equal(safeReturnToPath('/connections?connected=1'), '/connections?connected=1')
})

test('safeReturnToPath rejects protocol-relative, backslash, and absolute URLs', () => {
  assert.equal(safeReturnToPath('//evil.com'), undefined)
  assert.equal(safeReturnToPath('/\\evil.com'), undefined)
  assert.equal(safeReturnToPath('\\/evil.com'), undefined)
  assert.equal(safeReturnToPath('https://evil.com'), undefined)
  assert.equal(safeReturnToPath(''), undefined)
  assert.equal(safeReturnToPath(undefined), undefined)
})

test('safeReturnToPath rejects backslashes anywhere in the path', () => {
  assert.equal(safeReturnToPath('/connect\\..'), undefined)
})

test('safeReturnToPath rejects control characters (WHATWG strips them before parsing)', () => {
  assert.equal(safeReturnToPath('/\t/evil.com'), undefined)
  assert.equal(safeReturnToPath('/\n/evil.com'), undefined)
  assert.equal(safeReturnToPath('/\r/evil.com'), undefined)
  assert.equal(safeReturnToPath('/connect '), undefined)
})

// ── offline_access ───────────────────────────────────────────────────────────

test('a server that can issue refresh tokens is asked for one', () => {
  // Without this scope most providers issue no refresh_token at all, and the
  // connection is un-renewable from the moment it is created — it does not
  // expire so much as never become renewable.
  assert.equal(
    withOfflineAccess('claudeai', ['claudeai', 'offline_access']),
    'claudeai offline_access',
  )
})

test('a server that does NOT advertise it is not asked', () => {
  // An authorization server that publishes scopes_supported and receives one
  // outside the list answers invalid_scope and refuses the whole
  // authorization. Trading "might not renew" for "cannot connect" is worse.
  assert.equal(withOfflineAccess('claudeai', ['claudeai']), 'claudeai')
})

test('a server that publishes no scopes at all is left alone', () => {
  assert.equal(withOfflineAccess('claudeai', undefined), 'claudeai')
  assert.equal(withOfflineAccess('claudeai', []), 'claudeai')
})

test('an explicit request for offline_access is honoured and not duplicated', () => {
  // The start route's `scope` parameter is the override for a server whose
  // metadata is silent but which does support renewal.
  assert.equal(withOfflineAccess('offline_access read', undefined), 'offline_access read')
  assert.equal(
    withOfflineAccess('offline_access', ['offline_access']),
    'offline_access',
  )
})

test('scope strings survive odd whitespace', () => {
  assert.equal(withOfflineAccess('  read   write  ', ['offline_access']), 'read write offline_access')
})

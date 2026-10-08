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

// ── SSRF guard on server-chosen endpoints ────────────────────────────────────

import { after, before } from 'node:test'
import { __setSsrfResolver } from '@/lib/net/ssrf'
import { assertPublicOAuthEndpoints, discoverAuthServer } from '../oauth-authcode'

before(() => {
  // Deterministic DNS: a public IdP, and a host that resolves to a private
  // address the way an attacker-controlled discovery document would arrange.
  __setSsrfResolver(async (host) => {
    if (host === 'idp.example.com') return [{ address: '203.0.113.10', family: 4 }]
    if (host === 'internal.example.com') return [{ address: '10.0.0.5', family: 4 }]
    throw new Error(`unexpected host ${host}`)
  })
})
after(() => __setSsrfResolver(null))

const publicMeta = {
  authorization_endpoint: 'https://idp.example.com/authorize',
  token_endpoint: 'https://idp.example.com/token',
  registration_endpoint: 'https://idp.example.com/register',
}

test('public https endpoints pass, with or without a registration endpoint', async () => {
  await assertPublicOAuthEndpoints(publicMeta)
  await assertPublicOAuthEndpoints({ ...publicMeta, registration_endpoint: undefined })
})

test('an http token endpoint is refused — the exchange would carry the client secret in clear', async () => {
  await assert.rejects(
    assertPublicOAuthEndpoints({ ...publicMeta, token_endpoint: 'http://idp.example.com/token' }),
    /token_endpoint is not a public https URL/,
  )
})

test('a registration endpoint pointing at a private address is refused', async () => {
  await assert.rejects(
    assertPublicOAuthEndpoints({ ...publicMeta, registration_endpoint: 'https://internal.example.com/register' }),
    /registration_endpoint is not a public https URL/,
  )
  await assert.rejects(
    assertPublicOAuthEndpoints({ ...publicMeta, authorization_endpoint: 'https://169.254.169.254/latest/' }),
    /authorization_endpoint is not a public https URL/,
  )
})

test('discovery refuses a non-public server URL before any request is made', async () => {
  await assert.rejects(discoverAuthServer('http://127.0.0.1:9/mcp'), /https/)
  await assert.rejects(discoverAuthServer('https://internal.example.com/mcp'), /private or reserved/)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectReturnPath, entitlementConnectHref, mcpConnectHref } from '../connect-links'
import { EMBED_COMPLETE_PATH } from '@/lib/embed'
import { safeReturnToPath } from '@/lib/mcp/oauth-authcode'

test('outside a frame both connect steps come back to the onboarding screen', () => {
  assert.equal(connectReturnPath(false), '/connect')
  const entitlement = new URL(entitlementConnectHref('/connect'), 'https://example.com')
  assert.equal(entitlement.pathname, '/api/peopleai/connect')
  assert.equal(entitlement.searchParams.get('return_to'), '/connect')

  const mcp = new URL(mcpConnectHref('conn_1', '/connect'), 'https://example.com')
  assert.equal(mcp.pathname, '/api/mcp-connections/oauth/start')
  assert.equal(mcp.searchParams.get('connectionId'), 'conn_1')
  assert.equal(mcp.searchParams.get('returnTo'), '/connect')
})

test('inside a frame both steps come back to the popup landing page instead', () => {
  // The regression this pins: run in the frame, the OAuth redirect chain ends
  // on /connect with error=oauth_state — the third-party frame never stored
  // the SameSite=Lax state cookie, and the IdP will not render framed at all.
  // The popup runs the same flow top-level and lands somewhere that can tell
  // the frame and close.
  assert.equal(connectReturnPath(true), EMBED_COMPLETE_PATH)

  const entitlement = new URL(entitlementConnectHref(connectReturnPath(true)), 'https://example.com')
  assert.equal(entitlement.searchParams.get('return_to'), EMBED_COMPLETE_PATH)

  const mcp = new URL(mcpConnectHref('conn_1', connectReturnPath(true)), 'https://example.com')
  assert.equal(mcp.searchParams.get('returnTo'), EMBED_COMPLETE_PATH)
})

test('return paths are encoded, not concatenated, so the server reads them whole', () => {
  // A raw `?` in the value would truncate the parameter at the server.
  const href = mcpConnectHref('conn_1', '/auth/embedded-complete?flow=connect')
  assert.ok(!href.includes('embedded-complete?flow'), href)
  const parsed = new URL(href, 'https://example.com')
  assert.equal(parsed.searchParams.get('returnTo'), '/auth/embedded-complete?flow=connect')
})

test('every return path these links carry is one the OAuth routes will honor', () => {
  for (const embedded of [true, false]) {
    assert.equal(safeReturnToPath(connectReturnPath(embedded)), connectReturnPath(embedded))
  }
})

test('a connection id that has not loaded yet still produces a parseable href', () => {
  const mcp = new URL(mcpConnectHref(null, '/connect'), 'https://example.com')
  assert.equal(mcp.searchParams.get('connectionId'), '')
})

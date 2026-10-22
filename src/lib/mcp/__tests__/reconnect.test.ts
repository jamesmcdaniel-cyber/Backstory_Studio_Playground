import test from 'node:test'
import assert from 'node:assert/strict'
import { needsSignIn, newConnectionLanded, reconnectHref, reconnectLanded, type ListedConnection, type ReconnectableConnection } from '@/lib/mcp/reconnect'

const connection = (over: Partial<ReconnectableConnection> = {}): ReconnectableConnection => ({
  id: 'mcp-1',
  provider: null,
  auth: { authType: 'oauth2', flow: 'authcode' },
  ...over,
})

test('a server someone added through the OAuth redirect can be re-connected', () => {
  // The regression this module exists for: `provider` is null on every
  // self-added server, so keying off it left exactly these connections with no
  // way back once their token expired.
  assert.equal(needsSignIn(connection()), true)
})

test('a platform-managed server can be re-connected too', () => {
  assert.equal(needsSignIn(connection({ provider: 'backstory' })), true)
})

test('a stored credential is not re-connected, it is edited', () => {
  for (const auth of [
    { authType: 'api_key' },
    { authType: 'oauth2' }, // client credentials — no flow marker
    { authType: 'none' },
  ]) {
    assert.equal(needsSignIn(connection({ auth })), false, auth.authType)
  }
})

test('re-connecting carries the connection id and nothing else', () => {
  // The whole fix: the URL is NOT in this link, because the server already has
  // it. Putting it here is what made an expired connection look like a new one.
  const href = reconnectHref(connection(), '/integrations?tab=servers')
  const url = new URL(href, 'https://example.com')
  assert.equal(url.pathname, '/api/mcp-connections/oauth/start')
  assert.equal(url.searchParams.get('connectionId'), 'mcp-1')
  assert.equal(url.searchParams.get('serverUrl'), null)
  assert.equal(url.searchParams.get('returnTo'), '/integrations?tab=servers')
})

test('a returnTo with its own query survives being embedded', () => {
  const href = reconnectHref(connection(), '/integrations?tab=servers')
  assert.match(href, /returnTo=%2Fintegrations%3Ftab%3Dservers/)
})

// ── the embedded sign-in wait ──────────────────────────────────────────────

const listed = (over: Partial<ListedConnection> = {}): ListedConnection => ({
  id: 'mcp-1', name: 'Linear', serverUrl: 'https://mcp.linear.app/mcp', isActive: true,
  lastVerifiedAt: '2026-10-20T10:00:00.000Z', healthStatus: 'healthy', ...over,
})

test('a re-connect has landed only once the server re-verified the row', () => {
  const before = { lastVerifiedAt: '2026-10-20T10:00:00.000Z' }
  assert.equal(reconnectLanded(before, listed()), false, 'an unchanged stamp is the old connection')
  assert.equal(reconnectLanded(before, listed({ lastVerifiedAt: '2026-10-22T12:00:00.000Z' })), true)
  assert.equal(reconnectLanded({ lastVerifiedAt: null }, listed()), true, 'a first verification counts')
  assert.equal(reconnectLanded(before, listed({ lastVerifiedAt: '2026-10-22T12:00:00.000Z', healthStatus: 'unhealthy' })), false)
  assert.equal(reconnectLanded(before, listed({ lastVerifiedAt: '2026-10-22T12:00:00.000Z', isActive: false })), false)
  assert.equal(reconnectLanded(before, undefined), false)
})

test('a new SSO server has landed once a row with its name and URL appears that was not there before', () => {
  const wanted = { name: 'Linear', serverUrl: 'https://mcp.linear.app/mcp' }
  assert.equal(newConnectionLanded(wanted, new Set(['mcp-1']), [listed()]), false, 'the same server added earlier is not this sign-in')
  assert.equal(newConnectionLanded(wanted, new Set(['mcp-1']), [listed(), listed({ id: 'mcp-2' })]), true)
  assert.equal(newConnectionLanded(wanted, new Set(), [listed({ name: 'Other' })]), false)
})

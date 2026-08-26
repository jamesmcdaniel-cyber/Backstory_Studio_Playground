import test from 'node:test'
import assert from 'node:assert/strict'
import { needsSignIn, reconnectHref, type ReconnectableConnection } from '@/lib/mcp/reconnect'

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

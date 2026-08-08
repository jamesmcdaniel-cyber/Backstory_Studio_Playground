import test from 'node:test'
import assert from 'node:assert/strict'
import { contentSecurityPolicy } from '../csp'

test('production CSP nonces scripts and closes dangerous fallback sources', () => {
  const policy = contentSecurityPolicy('nonce-value', true)
  assert.match(policy, /script-src 'self' 'nonce-nonce-value' 'strict-dynamic'/)
  assert.match(policy, /default-src 'self'/)
  assert.match(policy, /object-src 'none'/)
  assert.match(policy, /frame-ancestors 'none'/)
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/)
  assert.doesNotMatch(policy, /'unsafe-eval'/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { contentSecurityPolicy } from '../csp'

test('production CSP allows static-page scripts and closes dangerous fallback sources', () => {
  const policy = contentSecurityPolicy(true)
  // Statically prerendered HTML carries un-nonced inline bootstrap scripts, so
  // 'unsafe-inline' is required; 'strict-dynamic'/nonce policies black out the
  // whole app (2026-08-09 outage). External script hosts stay blocked by 'self'.
  assert.match(policy, /script-src 'self' 'unsafe-inline'(;|$)/)
  assert.doesNotMatch(policy, /'strict-dynamic'/)
  assert.match(policy, /default-src 'self'/)
  assert.match(policy, /object-src 'none'/)
  assert.match(policy, /frame-ancestors 'none'/)
  assert.match(policy, /base-uri 'self'/)
  assert.match(policy, /form-action 'self'/)
  assert.match(policy, /upgrade-insecure-requests/)
  assert.doesNotMatch(policy, /'unsafe-eval'/)
})

test('development CSP additionally allows eval for React refresh', () => {
  const policy = contentSecurityPolicy(false)
  assert.match(policy, /script-src[^;]*'unsafe-eval'/)
  assert.doesNotMatch(policy, /upgrade-insecure-requests/)
})

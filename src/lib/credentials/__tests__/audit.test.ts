import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeScopes } from '../audit'

/**
 * The dedup path writes through recordAudit → prisma, so it is exercised in the
 * DB-backed suite. What is unit-testable here is scope normalisation, which is
 * what makes an over-scoped grant visible: two grants of the same access must
 * compare equal in the log however the provider happened to order them.
 */

beforeEach(() => {})

test('normalizeScopes accepts the space-delimited form OAuth actually sends', () => {
  assert.deepEqual(normalizeScopes('chat:write channels:read'), ['channels:read', 'chat:write'])
})

test('normalizeScopes accepts the array form Nango returns', () => {
  assert.deepEqual(normalizeScopes(['chat:write', 'channels:read']), ['channels:read', 'chat:write'])
})

test('normalizeScopes sorts, so scope order never makes two identical grants differ', () => {
  assert.deepEqual(normalizeScopes('b a c'), normalizeScopes('c b a'))
})

test('normalizeScopes de-duplicates repeated scopes', () => {
  assert.deepEqual(normalizeScopes('read read write'), ['read', 'write'])
})

test('normalizeScopes tolerates comma-delimited and ragged whitespace', () => {
  assert.deepEqual(normalizeScopes('read,  write ,  admin'), ['admin', 'read', 'write'])
})

test('normalizeScopes returns null for absent or empty scopes, not an empty array', () => {
  // Null distinguishes "the provider told us nothing" from "granted no scopes",
  // which are different findings during a scope review.
  assert.equal(normalizeScopes(undefined), null)
  assert.equal(normalizeScopes(null), null)
  assert.equal(normalizeScopes(''), null)
  assert.equal(normalizeScopes('   '), null)
  assert.equal(normalizeScopes([]), null)
})

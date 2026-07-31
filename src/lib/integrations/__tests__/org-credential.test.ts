import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseCredential, envFallbackAllowed } from '../org-credential'

/**
 * The boundary this encodes: a platform-wide credential is a shared identity.
 * Letting a customer workspace use it means its agents act as — and can read
 * what belongs to — every other workspace on that same account.
 */

test('a workspace’s own credential always wins, whatever its kind', () => {
  for (const kind of ['customer', 'internal', 'partner', null, undefined]) {
    const resolved = chooseCredential('org-key', 'env-key', kind)
    assert.deepEqual(resolved, { value: 'org-key', source: 'org' }, `kind=${kind}`)
  }
})

test('a customer workspace never reaches the shared platform credential', () => {
  assert.equal(chooseCredential(null, 'env-key', 'customer'), null)
})

test('internal and partner workspaces may still use the platform credential', () => {
  assert.deepEqual(chooseCredential(null, 'env-key', 'internal'), { value: 'env-key', source: 'env' })
  assert.deepEqual(chooseCredential(null, 'env-key', 'partner'), { value: 'env-key', source: 'env' })
})

test('an unknown or missing org kind fails closed', () => {
  // Matches the schema default (`customer`). A workspace we cannot classify is
  // the last one that should inherit a shared account.
  assert.equal(chooseCredential(null, 'env-key', undefined), null)
  assert.equal(chooseCredential(null, 'env-key', null), null)
  assert.equal(chooseCredential(null, 'env-key', 'something-new'), null)
})

test('no credential anywhere resolves to null, not an empty string', () => {
  assert.equal(chooseCredential(null, undefined, 'internal'), null)
  assert.equal(chooseCredential('', '', 'internal'), null)
})

test('envFallbackAllowed is the whole policy, stated once', () => {
  assert.equal(envFallbackAllowed('internal'), true)
  assert.equal(envFallbackAllowed('partner'), true)
  assert.equal(envFallbackAllowed('customer'), false)
  assert.equal(envFallbackAllowed(undefined), false)
})

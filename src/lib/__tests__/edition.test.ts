import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { appEdition, isCustomerEdition, isInternalEdition } from '@/lib/edition'
// The one legitimate direct import of the constant: these tests assert the
// FALLBACK behavior, so they must compare against whatever the tree is built
// as. Asserting a literal 'internal' here would fail in Backstory_customers and
// force the two repos to carry different suites. Product code must never import
// this — use isCustomerEdition().
import { EDITION } from '@/lib/edition.config'

const original = process.env.APP_EDITION
const mutableEnv = process.env as Record<string, string | undefined>

afterEach(() => {
  if (original === undefined) delete process.env.APP_EDITION
  else process.env.APP_EDITION = original
})

describe('edition', () => {
  test('falls back to the committed constant when no override is set', () => {
    delete process.env.APP_EDITION
    assert.equal(appEdition(), EDITION)
    assert.equal(isInternalEdition(), EDITION === 'internal')
    assert.equal(isCustomerEdition(), EDITION === 'customer')
  })

  test('a non-production override selects the customer edition', () => {
    process.env.APP_EDITION = 'customer'
    assert.equal(appEdition(), 'customer')
    assert.equal(isCustomerEdition(), true)
    assert.equal(isInternalEdition(), false)
  })

  test('a non-production override selects the internal edition', () => {
    process.env.APP_EDITION = 'internal'
    assert.equal(appEdition(), 'internal')
    assert.equal(isInternalEdition(), true)
    assert.equal(isCustomerEdition(), false)
  })

  test('an unrecognized override is ignored rather than throwing', () => {
    process.env.APP_EDITION = 'nonsense'
    assert.equal(appEdition(), EDITION)
  })

  test('the override is refused in production, so a deploy cannot be flipped by config', () => {
    const priorNodeEnv = mutableEnv.NODE_ENV
    // Pick whichever edition this tree is NOT, so the assertion is meaningful
    // in both repos: if the override were honored, appEdition() would change.
    const opposite = EDITION === 'internal' ? 'customer' : 'internal'
    mutableEnv.NODE_ENV = 'production'
    process.env.APP_EDITION = opposite
    try {
      assert.equal(appEdition(), EDITION)
    } finally {
      mutableEnv.NODE_ENV = priorNodeEnv
    }
  })
})

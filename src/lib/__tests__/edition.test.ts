import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { appEdition, isCustomerEdition, isInternalEdition } from '@/lib/edition'

const original = process.env.APP_EDITION
const mutableEnv = process.env as Record<string, string | undefined>

afterEach(() => {
  if (original === undefined) delete process.env.APP_EDITION
  else process.env.APP_EDITION = original
})

describe('edition', () => {
  test('defaults to the committed constant when no override is set', () => {
    delete process.env.APP_EDITION
    assert.equal(appEdition(), 'internal')
    assert.equal(isInternalEdition(), true)
    assert.equal(isCustomerEdition(), false)
  })

  test('a non-production override selects the customer edition', () => {
    process.env.APP_EDITION = 'customer'
    assert.equal(appEdition(), 'customer')
    assert.equal(isCustomerEdition(), true)
    assert.equal(isInternalEdition(), false)
  })

  test('an unrecognized override is ignored rather than throwing', () => {
    process.env.APP_EDITION = 'nonsense'
    assert.equal(appEdition(), 'internal')
  })

  test('the override is refused in production, so a deploy cannot be flipped by config', () => {
    const priorNodeEnv = mutableEnv.NODE_ENV
    mutableEnv.NODE_ENV = 'production'
    process.env.APP_EDITION = 'customer'
    try {
      assert.equal(appEdition(), 'internal')
    } finally {
      mutableEnv.NODE_ENV = priorNodeEnv
    }
  })
})

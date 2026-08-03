import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { isEditionBlockedPath } from '@/lib/edition'

afterEach(() => { delete process.env.APP_EDITION })

describe('isEditionBlockedPath', () => {
  test('blocks the admin surface in the customer edition', () => {
    process.env.APP_EDITION = 'customer'
    assert.equal(isEditionBlockedPath('/admin'), true)
    assert.equal(isEditionBlockedPath('/admin/catalogue'), true)
    assert.equal(isEditionBlockedPath('/admin/costs'), true)
    assert.equal(isEditionBlockedPath('/admin/domains'), true)
  })

  test('blocks nothing in the internal edition', () => {
    // Set explicitly rather than deleting: the fork commits EDITION='customer',
    // so relying on the default would make this suite edition-dependent.
    process.env.APP_EDITION = 'internal'
    assert.equal(isEditionBlockedPath('/admin'), false)
    assert.equal(isEditionBlockedPath('/admin/catalogue'), false)
  })

  test('does not block unrelated paths that merely start with the same letters', () => {
    process.env.APP_EDITION = 'customer'
    assert.equal(isEditionBlockedPath('/administrate'), false)
    assert.equal(isEditionBlockedPath('/dashboard'), false)
    assert.equal(isEditionBlockedPath('/flows'), false)
  })

  test('does not block the API routes, which carry their own internalOnly gate', () => {
    process.env.APP_EDITION = 'customer'
    // /api/admin/* is gated at the handler (404 via withAuthenticatedApi), not
    // here — this prefix is for pages. Asserted so the two layers stay distinct.
    assert.equal(isEditionBlockedPath('/api/admin/costs'), false)
  })
})

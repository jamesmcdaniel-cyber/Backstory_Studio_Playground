import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

afterEach(() => { delete process.env.APP_EDITION })

const request = () => new NextRequest('http://localhost/api/thing', { method: 'GET' })

describe('internalOnly', () => {
  test('404s in the customer edition without invoking the handler', async () => {
    process.env.APP_EDITION = 'customer'
    let invoked = false
    const route = withAuthenticatedApi(async () => { invoked = true; return { success: true } }, { internalOnly: true, permission: null })

    const response = await route(request())

    assert.equal(response.status, 404)
    assert.equal(invoked, false, 'handler must not run')
    assert.deepEqual(await response.json(), { success: false, error: 'Not found', code: 'NOT_FOUND' })
  })

  test('does not 404 in the internal edition', async () => {
    delete process.env.APP_EDITION
    const route = withAuthenticatedApi(async () => ({ success: true }), { internalOnly: true, permission: null })

    const response = await route(request())

    // No test-auth context here, so this is 401 — the point is that it is NOT 404.
    assert.notEqual(response.status, 404)
  })

  test('an ungated route is unaffected in the customer edition', async () => {
    process.env.APP_EDITION = 'customer'
    const route = withAuthenticatedApi(async () => ({ success: true }), { permission: null })

    const response = await route(request())

    assert.notEqual(response.status, 404)
  })
})

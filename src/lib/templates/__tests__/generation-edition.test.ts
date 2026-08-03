import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { maybeGenerateOnGateClear, sweepTemplateGeneration } from '@/lib/templates/generation-queue'

afterEach(() => { delete process.env.APP_EDITION })

describe('generation is inert in the customer edition', () => {
  test('maybeGenerateOnGateClear dispatches nothing', async () => {
    process.env.APP_EDITION = 'customer'
    // No DB is touched: the edition guard returns before any query, so this
    // passes without a TEST_DATABASE_URL. That is the assertion.
    const result = await maybeGenerateOnGateClear('org-that-does-not-exist')
    assert.deepEqual(result, { dispatched: false, reason: 'gate' })
  })

  test('sweepTemplateGeneration returns no orgs', async () => {
    process.env.APP_EDITION = 'customer'
    const result = await sweepTemplateGeneration(new Date('2026-08-03T00:00:00Z'))
    assert.deepEqual(result, [])
  })
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runActivityBackfill, BACKFILL_MAX_EVENTS_PER_JOB } from '../backfill'

/**
 * Pure (no-DB) coverage: the stubbed sources. Slack's real path (persist,
 * cursor, cap, idempotency, no-dispatch) is DB-backed in backfill.db.test.ts —
 * these branches return before ever touching Prisma, so they're safe to run
 * without TEST_DATABASE_URL.
 */

test('BACKFILL_MAX_EVENTS_PER_JOB is the documented 2000', () => {
  assert.equal(BACKFILL_MAX_EVENTS_PER_JOB, 2000)
})

test('salesforce reports unsupported without touching the database', async () => {
  const result = await runActivityBackfill('org-1', 'salesforce', 'conn-1')
  assert.equal(result.status, 'unsupported')
  if (result.status === 'unsupported') {
    assert.match(result.reason, /no new provider API client/)
  }
})

test('github reports unsupported without touching the database', async () => {
  const result = await runActivityBackfill('org-1', 'github', 'conn-1')
  assert.equal(result.status, 'unsupported')
})

test('an unknown source reports unsupported rather than throwing', async () => {
  const result = await runActivityBackfill('org-1', 'nango:zendesk', 'conn-1')
  assert.equal(result.status, 'unsupported')
})

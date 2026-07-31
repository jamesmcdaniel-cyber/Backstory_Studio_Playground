import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OrgCapacity } from '../org-capacity'

/**
 * The regression: nothing bounded how much of the shared worker pool one
 * workspace could hold, so a single org's burst of scheduled runs filled every
 * slot and other tenants' runs sat pending until the reaper failed them.
 */

const ORG_A = 'org-a'
const ORG_B = 'org-b'

test('a workspace already at the ceiling gets no new slots', () => {
  process.env.ORG_MAX_INFLIGHT_RUNS = '3'
  const capacity = new OrgCapacity(new Map([[ORG_A, 3]]))

  assert.equal(capacity.tryClaim(ORG_A), false)
  assert.deepEqual(capacity.saturatedOrgs(), [ORG_A])
  delete process.env.ORG_MAX_INFLIGHT_RUNS
})

test('claims accumulate within a tick, so a burst cannot exceed the ceiling', () => {
  process.env.ORG_MAX_INFLIGHT_RUNS = '3'
  const capacity = new OrgCapacity(new Map([[ORG_A, 1]]))

  assert.equal(capacity.tryClaim(ORG_A), true)  // 2
  assert.equal(capacity.tryClaim(ORG_A), true)  // 3
  assert.equal(capacity.tryClaim(ORG_A), false, 'the in-tick counter must include claims made this tick')
  delete process.env.ORG_MAX_INFLIGHT_RUNS
})

test('one saturated workspace does not block another', () => {
  process.env.ORG_MAX_INFLIGHT_RUNS = '2'
  const capacity = new OrgCapacity(new Map([[ORG_A, 2]]))

  assert.equal(capacity.tryClaim(ORG_A), false)
  assert.equal(capacity.tryClaim(ORG_B), true, 'the whole point is that a noisy tenant is isolated')
  assert.deepEqual(capacity.saturatedOrgs(), [ORG_A])
  delete process.env.ORG_MAX_INFLIGHT_RUNS
})

test('an org with nothing in flight starts from zero', () => {
  process.env.ORG_MAX_INFLIGHT_RUNS = '2'
  const capacity = new OrgCapacity(new Map())

  assert.equal(capacity.tryClaim(ORG_A), true)
  assert.equal(capacity.tryClaim(ORG_A), true)
  assert.equal(capacity.tryClaim(ORG_A), false)
  delete process.env.ORG_MAX_INFLIGHT_RUNS
})

test('saturated orgs are reported once, not once per rejected claim', () => {
  process.env.ORG_MAX_INFLIGHT_RUNS = '1'
  const capacity = new OrgCapacity(new Map([[ORG_A, 5]]))

  capacity.tryClaim(ORG_A)
  capacity.tryClaim(ORG_A)
  capacity.tryClaim(ORG_A)

  assert.deepEqual(capacity.saturatedOrgs(), [ORG_A], 'the tick logs one line, not one per candidate')
  delete process.env.ORG_MAX_INFLIGHT_RUNS
})

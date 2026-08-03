import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowJobOptions } from '../queue-options'

test('flowJobOptions: a resume (flowRunId present) gets a run-scoped jobId and no attempts override', () => {
  const opts = flowJobOptions('run-1', undefined, undefined, 1000)
  assert.equal(opts.jobId, 'run-1-resume-1000')
  assert.equal(opts.attempts, undefined)
})

test('flowJobOptions: a prepared run (row created up front) gets a stable dedupe jobId and attempts:1', () => {
  const opts = flowJobOptions(undefined, 'run-2')
  assert.equal(opts.jobId, 'run-2-start')
  assert.equal(opts.attempts, 1)
})

test('flowJobOptions: a fresh execution (no flowRunId) gets attempts:1 and no jobId', () => {
  const opts = flowJobOptions(undefined)
  assert.equal(opts.attempts, 1)
  assert.equal(opts.jobId, undefined)
})

test('flowJobOptions: an outbox delivery gets a stable queue id', () => {
  assert.deepEqual(flowJobOptions(undefined, undefined, 'event-1-flow-1'), {
    jobId: 'delivery-event-1-flow-1',
    attempts: 1,
  })
})

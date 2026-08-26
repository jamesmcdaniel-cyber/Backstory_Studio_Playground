import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_STOP_ERROR, stopOutcome } from '@/lib/flows/stop-error'

/**
 * "We are done here" and "this is wrong, fail the run" are different things,
 * and a flow that detects a bad state had no way to say the second one.
 */

test('a stop with no error type ends the run quietly, as it always has', () => {
  // Every flow saved before this. Changing what they do would be the one
  // unacceptable outcome of adding the option.
  assert.deepEqual(stopOutcome({}), { kind: 'quiet', message: 'Flow stopped.' })
  assert.deepEqual(stopOutcome({ reason: 'Nothing to do' }), { kind: 'quiet', message: 'Nothing to do' })
})

test('an error message raises, and never blank', () => {
  assert.deepEqual(stopOutcome({ errorType: 'errorMessage', errorMessage: 'No account matched' }), {
    kind: 'error',
    message: 'No account matched',
  })
  // Falls back to the reason, then to a default — a raised error with no words
  // is the least useful thing this could produce.
  assert.equal(stopOutcome({ errorType: 'errorMessage', reason: 'Bad state' }).message, 'Bad state')
  assert.equal(stopOutcome({ errorType: 'errorMessage' }).message, DEFAULT_STOP_ERROR)
  assert.equal(stopOutcome({ errorType: 'errorMessage', errorMessage: '   ' }).message, DEFAULT_STOP_ERROR)
})

test('an error object surfaces its message and carries the whole object', () => {
  const outcome = stopOutcome({
    errorType: 'errorObject',
    errorObject: '{"message":"Quota exceeded","code":429,"account":"Acme"}',
  })
  assert.equal(outcome.kind, 'error')
  assert.equal(outcome.message, 'Quota exceeded')
  assert.deepEqual(outcome.kind === 'error' ? outcome.detail : null, {
    message: 'Quota exceeded',
    code: 429,
    account: 'Acme',
  })
})

test('an object with no message still raises, with the object attached', () => {
  const outcome = stopOutcome({ errorType: 'errorObject', errorObject: '{"code":429}' })
  assert.equal(outcome.message, DEFAULT_STOP_ERROR)
  assert.deepEqual(outcome.kind === 'error' ? outcome.detail : null, { code: 429 })
})

test('unparseable JSON still fails the run rather than passing silently', () => {
  // Failing to fail is the worst outcome available here: the author asked for
  // an error and a malformed body must not turn that into a quiet success.
  const outcome = stopOutcome({ errorType: 'errorObject', errorObject: 'not json at all' })
  assert.equal(outcome.kind, 'error')
  assert.equal(outcome.message, 'not json at all')
})

test('an empty error object raises the default rather than nothing', () => {
  assert.deepEqual(stopOutcome({ errorType: 'errorObject', errorObject: '  ' }), {
    kind: 'error',
    message: DEFAULT_STOP_ERROR,
  })
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  unrecoveredToolFailures,
  toolFailureBlockReason,
  toolFailureWarnings,
  type ToolFailure,
} from '../tool-failure-outcome'

const fail = (name: string, isWrite: boolean, message = 'boom'): ToolFailure => ({ name, isWrite, message })

test('a failure the run later recovered from is not held against it', () => {
  const unrecovered = unrecoveredToolFailures([fail('gmail_send_email', true)], new Set(['gmail_send_email']))
  assert.deepEqual(unrecovered, [])
})

test('a failure with no later success survives', () => {
  const unrecovered = unrecoveredToolFailures([fail('gmail_send_email', true)], new Set(['get_scorecard']))
  assert.equal(unrecovered.length, 1)
})

test('repeated failures of one tool are reported once, not once per attempt', () => {
  const unrecovered = unrecoveredToolFailures(
    [fail('situation_search', false), fail('situation_search', false)],
    new Set(),
  )
  assert.equal(unrecovered.length, 1)
})

test('an unrecovered WRITE blocks the run — it did not do what it was asked', () => {
  const reason = toolFailureBlockReason([fail('gmail_send_email', true, 'timeout')])
  assert.ok(reason)
  assert.match(reason!, /gmail_send_email/)
  assert.match(reason!, /timeout/)
})

test('an unrecovered READ never blocks — the artifact was still produced', () => {
  assert.equal(toolFailureBlockReason([fail('situation_search', false)]), null)
})

test('no failures means nothing to report', () => {
  assert.equal(toolFailureBlockReason([]), null)
  assert.deepEqual(toolFailureWarnings([]), [])
})

test('an unrecovered read is surfaced as degraded evidence, not silence', () => {
  const warnings = toolFailureWarnings([fail('situation_search', false, 'The operation was aborted due to timeout')])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /situation_search/)
  assert.match(warnings[0], /timeout/)
})

test('a blocking write is not also repeated as a warning', () => {
  const failures = [fail('gmail_send_email', true), fail('situation_search', false)]
  const warnings = toolFailureWarnings(failures)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /situation_search/)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { truncateWithMarker, truncateError } from '../truncate'

test('truncateWithMarker passes text through unchanged when at or under the limit', () => {
  assert.equal(truncateWithMarker('short', 300), 'short')
  assert.equal(truncateWithMarker('exact-length-text', 'exact-length-text'.length), 'exact-length-text')
})

test('truncateWithMarker never appends a marker on exact-length input', () => {
  const text = 'x'.repeat(50)
  const result = truncateWithMarker(text, 50)
  assert.equal(result, text)
  assert.doesNotMatch(result, /truncated/)
})

test('truncateWithMarker appends an explicit marker with the exact overflow count', () => {
  const text = 'a'.repeat(310)
  const result = truncateWithMarker(text, 300)
  assert.equal(result, 'a'.repeat(300) + '\n… [truncated 10 chars]')
})

test('truncateWithMarker handles empty string and zero max', () => {
  assert.equal(truncateWithMarker('', 300), '')
  assert.equal(truncateWithMarker('abc', 0), '\n… [truncated 3 chars]')
})

test('truncateError stringifies an Error input then applies the marker', () => {
  const err = new Error('boom'.repeat(100))
  const result = truncateError(err)
  assert.ok(result.startsWith('boom'))
  assert.match(result, /\[truncated \d+ chars\]$/)
})

test('truncateError passes a short Error message through unchanged', () => {
  const err = new Error('short failure')
  assert.equal(truncateError(err), 'short failure')
})

test('truncateError handles a plain string input', () => {
  assert.equal(truncateError('plain failure'), 'plain failure')
  const long = 'z'.repeat(400)
  assert.equal(truncateError(long), 'z'.repeat(300) + '\n… [truncated 100 chars]')
})

test('truncateError handles an object input by stringifying it', () => {
  const result = truncateError({ code: 'E_FAIL', detail: 'x'.repeat(400) })
  assert.match(result, /^\{"code":"E_FAIL"/)
  assert.match(result, /\[truncated \d+ chars\]$/)
})

test('truncateError respects a custom max', () => {
  const result = truncateError('0123456789', 5)
  assert.equal(result, '01234\n… [truncated 5 chars]')
})

test('truncateError falls back to String() for values JSON.stringify cannot handle', () => {
  const circular: Record<string, unknown> = {}
  circular.self = circular
  const result = truncateError(circular)
  assert.equal(typeof result, 'string')
})

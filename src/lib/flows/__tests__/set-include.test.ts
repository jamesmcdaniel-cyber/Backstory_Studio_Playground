import { test } from 'node:test'
import assert from 'node:assert/strict'
import { carriedFields } from '@/lib/flows/set-include'

const input = { id: 'a1', name: 'Acme', owner: 'Alex', secretish: 'x' }

/**
 * We shipped the boolean half of this and not the half that says WHICH.
 * All-or-nothing forces a choice between dragging an entire upstream record
 * into every downstream step, or re-mapping every field you wanted to keep.
 */

test('off carries nothing, which is the default', () => {
  assert.deepEqual(carriedFields(input, {}), {})
  assert.deepEqual(carriedFields(input, { includeOtherFields: false }), {})
})

test('on with no mode carries everything — what the boolean always meant', () => {
  assert.deepEqual(carriedFields(input, { includeOtherFields: true }), input)
})

test('selected carries only the named fields', () => {
  assert.deepEqual(
    carriedFields(input, { includeOtherFields: true, includeMode: 'selected', includeFields: ['id', 'name'] }),
    { id: 'a1', name: 'Acme' },
  )
})

test('except carries everything but the named fields', () => {
  assert.deepEqual(
    carriedFields(input, { includeOtherFields: true, includeMode: 'except', includeFields: ['secretish'] }),
    { id: 'a1', name: 'Acme', owner: 'Alex' },
  )
})

test('an empty list means what each mode says, not "ignore me"', () => {
  // selected-with-nothing-selected carries nothing; except-with-nothing-excluded
  // carries everything. Treating both as "no filter" would make one of them lie.
  assert.deepEqual(carriedFields(input, { includeOtherFields: true, includeMode: 'selected', includeFields: [] }), {})
  assert.deepEqual(carriedFields(input, { includeOtherFields: true, includeMode: 'except', includeFields: [] }), input)
})

test('blank entries in a field list make no rule', () => {
  // A trailing comma should not create a rule about a field named "".
  assert.deepEqual(
    carriedFields({ '': 'blank', id: 'a1' }, { includeOtherFields: true, includeMode: 'selected', includeFields: ['id', '  ', ''] }),
    { id: 'a1' },
  )
})

test('a non-record input carries nothing rather than throwing', () => {
  for (const value of [null, undefined, 'text', 42, ['a']]) {
    assert.deepEqual(carriedFields(value, { includeOtherFields: true }), {}, String(value))
  }
})

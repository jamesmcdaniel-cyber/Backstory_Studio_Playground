import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fieldTypeForToken, operatorsForField, operatorsForType } from '@/lib/flows/condition-ops'
import { CONDITION_OPS } from '@/lib/flows/graph'
import type { DataField } from '@/lib/flows/datatree'

const FIELDS: DataField[] = [
  {
    label: 'Account',
    token: '{{steps.lookup.account}}',
    type: 'object',
    children: [
      { label: 'Name', token: '{{steps.lookup.account.name}}', type: 'string' },
      { label: 'Employees', token: '{{steps.lookup.account.employees}}', type: 'number' },
      { label: 'Active', token: '{{steps.lookup.account.active}}', type: 'boolean' },
    ],
  },
  { label: 'Tags', token: '{{steps.lookup.tags}}', type: 'array' },
]

/**
 * The evaluator is forgiving on purpose — `before` on a number compares the two
 * as strings rather than failing — so a nonsensical operator produces a
 * confident wrong answer instead of an error. Narrowing the list is what
 * prevents it being picked.
 */

test('a number is offered ordering, not text matching', () => {
  const ops = operatorsForType('number')
  assert.ok(ops.includes('gt') && ops.includes('lte'))
  assert.ok(!ops.includes('startsWith'), 'text matching is meaningless on a number')
  assert.ok(!ops.includes('before'), 'a number is not a date')
  assert.ok(!ops.includes('isTrue'))
})

test('text keeps date ordering — an ISO timestamp arrives as a string', () => {
  const ops = operatorsForType('string')
  assert.ok(ops.includes('before') && ops.includes('after'))
  assert.ok(ops.includes('contains'))
  assert.ok(!ops.includes('gt'), 'numeric ordering on text was never meaningful')
})

test('a boolean is offered its two states first', () => {
  assert.deepEqual(operatorsForType('boolean').slice(0, 2), ['isTrue', 'isFalse'])
})

test('a list is checked for membership, a record only for emptiness', () => {
  assert.ok(operatorsForType('array').includes('contains'))
  assert.ok(!operatorsForType('object').includes('contains'))
})

test('every narrowed set can still ask whether the value is there at all', () => {
  for (const type of ['string', 'number', 'boolean', 'array', 'object']) {
    const ops = operatorsForType(type)
    assert.ok(ops.includes('exists') && ops.includes('notExists'), type)
  }
})

test('an untyped value keeps every operator — the user knows more than we do', () => {
  assert.deepEqual(operatorsForType(undefined), CONDITION_OPS)
  assert.deepEqual(operatorsForType('any'), CONDITION_OPS)
})

test('a nested token resolves to its own type, not its parent’s', () => {
  assert.equal(fieldTypeForToken('{{steps.lookup.account.employees}}', FIELDS), 'number')
  assert.equal(fieldTypeForToken('{{steps.lookup.account}}', FIELDS), 'object')
  assert.equal(fieldTypeForToken('{{steps.lookup.tags}}', FIELDS), 'array')
})

test('a token written without braces still resolves', () => {
  assert.equal(fieldTypeForToken('steps.lookup.account.name', FIELDS), 'string')
})

test('a literal or unknown path types as nothing, and keeps every operator', () => {
  assert.equal(fieldTypeForToken('enterprise', FIELDS), undefined)
  assert.equal(fieldTypeForToken('{{steps.gone.field}}', FIELDS), undefined)
  assert.deepEqual(operatorsForField('enterprise', FIELDS), CONDITION_OPS)
})

test('a clause never loses the operator it already uses', () => {
  // A flow saved before this narrowing existed — or one where the author knows
  // the value is a date in a numeric column. Hiding it would rewrite what the
  // select shows with no way back to it.
  const ops = operatorsForField('{{steps.lookup.account.employees}}', FIELDS, 'startsWith')
  assert.ok(ops.includes('startsWith'))
  assert.ok(ops.includes('gt'), 'and the sensible ones are still there')
  // Order stays the canonical one, so the list does not reshuffle per clause.
  assert.deepEqual([...ops], CONDITION_OPS.filter((op) => ops.includes(op)))
})

test('an already-sensible operator does not widen the list', () => {
  const ops = operatorsForField('{{steps.lookup.account.employees}}', FIELDS, 'gt')
  assert.deepEqual([...ops], [...operatorsForType('number')])
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isIdentifierField,
  locatorDisplay,
  locatorModes,
  modeForValue,
  pickableRow,
  pruneArgLabels,
  setArgLabel,
} from '@/lib/flows/resource-locator'
import type { ToolField } from '@/lib/flows/tool-schema'

const field = (over: Partial<ToolField>): ToolField => ({
  name: 'query',
  label: 'Query',
  type: 'string',
  required: false,
  ...over,
})

/**
 * The case this exists for, verbatim from a People.ai MCP schema: "The internal
 * People.ai ID of the record to analyze. Use find_account or find_record_by_crm_id
 * to obtain this." The schema is telling the user to run another tool by hand and
 * paste an integer back, and then the form shows 18234 forever.
 */

test('an id argument is recognised from its name', () => {
  assert.equal(isIdentifierField(field({ name: 'peopleai_object_id', type: 'number' })), true)
  assert.equal(isIdentifierField(field({ name: 'accountId' })), true)
  assert.equal(isIdentifierField(field({ name: 'id' })), true)
  assert.equal(isIdentifierField(field({ name: 'crm_record_id' })), true)
  assert.equal(isIdentifierField(field({ name: 'external_uuid' })), true)
})

test('an id argument is recognised when only its description admits it', () => {
  assert.equal(
    isIdentifierField(
      field({
        name: 'record',
        description: 'The internal People.ai ID of the record. Use find_account to obtain this.',
      }),
    ),
    true,
  )
})

test('ordinary arguments are left alone', () => {
  assert.equal(isIdentifierField(field({ name: 'query' })), false)
  assert.equal(isIdentifierField(field({ name: 'message', description: 'What to send' })), false)
  // "identify" contains "id" as a substring; it is not an identifier field.
  assert.equal(isIdentifierField(field({ name: 'identifyBy', description: 'How to match' })), false)
  assert.equal(isIdentifierField(field({ name: 'payload', type: 'object' })), false)
  // A closed set already has a picker — its own dropdown.
  assert.equal(
    isIdentifierField(field({ name: 'record_id', options: [{ value: 'a', label: 'A' }] })),
    false,
  )
})

test('binding to an earlier step leads when there is upstream data', () => {
  // In a flow the id nearly always comes from a previous step, and binding is
  // correct for every run rather than for this one.
  assert.deepEqual(locatorModes({ canList: true, hasUpstreamData: true }), ['upstream', 'list', 'value'])
  assert.deepEqual(locatorModes({ canList: false, hasUpstreamData: true }), ['upstream', 'value'])
  // Entering a value is always available — it is the floor.
  assert.deepEqual(locatorModes({ canList: false, hasUpstreamData: false }), ['value'])
})

test('reopening a step lands on the control that holds its value', () => {
  const modes = locatorModes({ canList: true, hasUpstreamData: true })
  assert.equal(modeForValue('{{steps.find.id}}', modes), 'upstream')
  assert.equal(modeForValue('18234', modes), 'value')
  // Nothing chosen yet: offer the most useful way in.
  assert.equal(modeForValue('', modes), 'upstream')
})

test('a chosen record reads as its name, with the id still visible', () => {
  // The id is what the tool receives and what an error will quote, so hiding it
  // entirely trades one confusion for another.
  assert.deepEqual(locatorDisplay('18234', 'Acme Corp'), { primary: 'Acme Corp', secondary: '18234' })
  assert.deepEqual(locatorDisplay('18234'), { primary: '18234' })
  assert.deepEqual(locatorDisplay('18234', '18234'), { primary: '18234' })
  assert.deepEqual(locatorDisplay('  '), { primary: '' })
})

test('a node with no labels carries no empty object', () => {
  // A graph diff should not show a change that means nothing.
  assert.equal(setArgLabel(undefined, 'a', null), undefined)
  assert.equal(setArgLabel({ a: 'Acme' }, 'a', null), undefined)
  assert.deepEqual(setArgLabel(undefined, 'a', 'Acme'), { a: 'Acme' })
  assert.deepEqual(setArgLabel({ a: 'Acme' }, 'b', 'Beta'), { a: 'Acme', b: 'Beta' })
})

test('labels for arguments the tool no longer has are dropped', () => {
  // Switching a step to a different tool leaves stale labels; kept, they would
  // resurface naming something from another system entirely.
  assert.deepEqual(pruneArgLabels({ account_id: 'Acme', gone: 'Stale' }, [field({ name: 'account_id' })]), {
    account_id: 'Acme',
  })
  assert.equal(pruneArgLabels({ gone: 'Stale' }, [field({ name: 'other' })]), undefined)
  assert.equal(pruneArgLabels(undefined, []), undefined)
})

test('a result row is reduced to an id and a name', () => {
  assert.deepEqual(pickableRow({ id: 18234, name: 'Acme Corp', owner: 'Alex' }), {
    value: '18234',
    label: 'Acme Corp',
  })
  assert.deepEqual(pickableRow({ crm_id: 'CRM-9', accountName: 'Beta Ltd' }), {
    value: 'CRM-9',
    label: 'Beta Ltd',
  })
})

test('an unrecognised row shape is still pickable rather than unusable', () => {
  // The row came from someone else's API; a picker that only works for rows
  // shaped the way we expect is a picker that mostly does not work.
  assert.deepEqual(pickableRow({ weird_column: 'abc' }), { value: 'abc' })
  assert.equal(pickableRow({}), null)
  assert.equal(pickableRow({ nested: { a: 1 } }), null)
})

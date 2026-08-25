import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toolFieldDefaults, toolFields } from '@/lib/flows/tool-schema'

/**
 * The reader this replaces took `properties[name].type` and nothing else, so
 * every shape a real schema uses to say something precise — a union with a null
 * arm, a $ref, a bound, a format, a default — arrived as an unconstrained text
 * box. These cases are the ones that were silently losing information.
 */

// The real People.ai MCP `situation_search` schema, as the server publishes it.
const SITUATION_SEARCH = {
  type: 'object',
  properties: {
    object_type: {
      description: "The type of record to analyze: 'opportunity' analyzes a single deal; 'account' analyzes the account.",
      enum: ['account', 'opportunity'],
      type: 'string',
    },
    peopleai_object_id: {
      description: 'The internal People.ai ID of the record to analyze.',
      type: 'integer',
    },
    query: {
      description: 'A concise description of the deal challenge or concern to investigate.',
      type: 'string',
    },
  },
  required: ['query', 'object_type', 'peopleai_object_id'],
}

test('a real MCP schema reads as typed fields in required-first order', () => {
  const fields = toolFields(SITUATION_SEARCH)

  assert.deepEqual(fields.map((field) => field.name), ['object_type', 'peopleai_object_id', 'query'])
  assert.ok(fields.every((field) => field.required))

  const [objectType, objectId] = fields
  assert.equal(objectType.type, 'enum')
  assert.deepEqual(objectType.options, [
    { value: 'account', label: 'account' },
    { value: 'opportunity', label: 'opportunity' },
  ])
  // An integer is a number control, not a text box that happens to hold digits.
  assert.equal(objectId.type, 'number')
})

test('required fields come first, each group keeping its declared order', () => {
  const fields = toolFields({
    type: 'object',
    properties: {
      optionalA: { type: 'string' },
      needed: { type: 'string' },
      optionalB: { type: 'string' },
    },
    required: ['needed'],
  })
  assert.deepEqual(fields.map((field) => field.name), ['needed', 'optionalA', 'optionalB'])
})

test('an optional-by-union field reads as its real type, not as a string', () => {
  // How a generator spells "string or nothing" — the old reader saw no `type`
  // on the property and fell through to an unconstrained text box.
  const [field] = toolFields({
    type: 'object',
    properties: { cursor: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'Page cursor' } },
  })
  assert.equal(field.type, 'number')
  assert.equal(field.nullable, true)
  assert.equal(field.description, 'Page cursor')
})

test('the other spelling of nullable reads the same way', () => {
  const [field] = toolFields({ type: 'object', properties: { note: { type: ['string', 'null'] } } })
  assert.equal(field.type, 'string')
  assert.equal(field.nullable, true)
})

test('a union of consts is an enumeration written the long way', () => {
  const [field] = toolFields({
    type: 'object',
    properties: { status: { anyOf: [{ const: 'open' }, { const: 'closed_won' }] } },
  })
  assert.equal(field.type, 'enum')
  assert.deepEqual(field.options?.map((option) => option.value), ['open', 'closed_won'])
  // API constants are shown the way the rest of the builder shows identifiers.
  assert.equal(field.options?.[1].label, 'Closed won')
})

test('a local $ref resolves to the shape it points at', () => {
  const [field] = toolFields({
    type: 'object',
    properties: { priority: { $ref: '#/$defs/Priority' } },
    $defs: { Priority: { type: 'string', enum: ['low', 'high'], description: 'How urgent' } },
  })
  assert.equal(field.type, 'enum')
  assert.equal(field.description, 'How urgent')
})

test('a $ref cycle terminates instead of hanging', () => {
  const fields = toolFields({
    type: 'object',
    properties: { node: { $ref: '#/$defs/Node' } },
    $defs: { Node: { $ref: '#/$defs/Node' } },
  })
  assert.equal(fields.length, 1)
})

test('bounds and defaults survive the read', () => {
  const [field] = toolFields({
    type: 'object',
    properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
  })
  assert.equal(field.min, 1)
  assert.equal(field.max, 100)
  assert.equal(field.default, 20)
  assert.deepEqual(toolFieldDefaults([field]), { limit: 20 })
})

test('exclusive bounds narrow to the values actually allowed', () => {
  const [field] = toolFields({
    type: 'object',
    properties: { count: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 10 } },
  })
  assert.equal(field.min, 1)
  assert.equal(field.max, 9)
})

test('a date-time string gets a date control, not a text box', () => {
  const [field] = toolFields({ type: 'object', properties: { since: { type: 'string', format: 'date-time' } } })
  assert.equal(field.type, 'dateTime')
})

test('an array of enum members is a multi-select', () => {
  const [field] = toolFields({
    type: 'object',
    properties: { stages: { type: 'array', items: { type: 'string', enum: ['discovery', 'negotiation'] } } },
  })
  assert.equal(field.type, 'multiEnum')
  assert.deepEqual(field.options?.map((option) => option.value), ['discovery', 'negotiation'])
})

test('a schema title wins over the property key for the label', () => {
  const fields = toolFields({
    type: 'object',
    properties: {
      peopleai_object_id: { type: 'integer', title: 'Account' },
      crm_record_id: { type: 'string' },
    },
  })
  assert.equal(fields[0].label, 'Account')
  // No title: the key is made readable rather than shown as raw snake_case.
  assert.equal(fields[1].label, 'Crm record id')
  // …and the wire key is untouched.
  assert.equal(fields[1].name, 'crm_record_id')
})

test('a field with no usable type is free rather than silently a string', () => {
  const [field] = toolFields({ type: 'object', properties: { payload: {} } })
  assert.equal(field.type, 'any')
})

test('a schema with no properties yields nothing, whatever it is', () => {
  assert.deepEqual(toolFields({ type: 'object' }), [])
  assert.deepEqual(toolFields(null), [])
  assert.deepEqual(toolFields('nonsense'), [])
  assert.deepEqual(toolFields({ type: 'object', properties: null }), [])
})

test('allOf members fold into one set of properties', () => {
  const fields = toolFields({
    allOf: [
      { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      { type: 'object', properties: { b: { type: 'number' } } },
    ],
  })
  assert.deepEqual(fields.map((field) => field.name), ['a', 'b'])
  assert.equal(fields[0].required, true)
})

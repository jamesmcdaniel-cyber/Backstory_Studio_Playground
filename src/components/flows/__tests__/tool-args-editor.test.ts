import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, schemaFields, serializeArgs, type SchemaField } from '../tool-args-editor'

test('schemaFields reads a tool input schema into typed, labelled fields', () => {
  const fields = schemaFields({
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'Search query.' },
      limit: { type: 'integer' },
      mode: { type: 'string', enum: ['fast', 'deep'] },
    },
  })
  assert.deepEqual(fields, [
    { name: 'query', label: 'Query', type: 'string', required: true, description: 'Search query.' },
    { name: 'limit', label: 'Limit', type: 'number', required: false },
    { name: 'mode', label: 'Mode', type: 'enum', required: false, options: [
      { value: 'fast', label: 'fast' },
      { value: 'deep', label: 'deep' },
    ] },
  ])
})

test('serializeArgs preserves object, array, and any fields as JSON values', () => {
  const fields: SchemaField[] = [
    { name: 'payload', label: 'Payload', type: 'object', required: true },
    { name: 'items', label: 'Items', type: 'array', required: false },
    { name: 'metadata', label: 'Metadata', type: 'any', required: false },
  ]
  const json = serializeArgs(
    {
      payload: '{"account":"{{trigger.input.account}}","score":91}',
      items: '["a","b"]',
      metadata: 'true',
    },
    fields,
  )
  assert.deepEqual(JSON.parse(json), {
    payload: { account: '{{trigger.input.account}}', score: 91 },
    items: ['a', 'b'],
    metadata: true,
  })
})

test('serializeArgs leaves exact data tokens intact for runtime object substitution', () => {
  const fields: SchemaField[] = [{ name: 'payload', label: 'Payload', type: 'object', required: true }]
  assert.deepEqual(JSON.parse(serializeArgs({ payload: '{{trigger.input.record}}' }, fields)), {
    payload: '{{trigger.input.record}}',
  })
})

test('serializeArgs still coerces scalar fields', () => {
  const fields: SchemaField[] = [
    { name: 'limit', label: 'Limit', type: 'number', required: false },
    { name: 'dryRun', label: 'Dry run', type: 'boolean', required: false },
    { name: 'query', label: 'Query', type: 'string', required: false },
  ]
  assert.deepEqual(JSON.parse(serializeArgs({ limit: '5', dryRun: 'true', query: 'Acme' }, fields)), {
    limit: 5,
    dryRun: true,
    query: 'Acme',
  })
})

test('parseArgs makes structured args editable as field text', () => {
  assert.deepEqual(parseArgs('{"payload":{"id":1},"items":["a"],"query":"Acme"}'), {
    payload: '{"id":1}',
    items: '["a"]',
    query: 'Acme',
  })
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  agentHttpEndpointSchema,
  endpointParams,
  endpointToolDefinition,
  endpointToolName,
  fillEndpointTemplate,
  parseAgentHttpEndpoints,
  type AgentHttpEndpoint,
} from '@/lib/integrations/http-endpoints'

const endpoint = (over: Partial<AgentHttpEndpoint> = {}): AgentHttpEndpoint => ({
  id: 'ep-1',
  name: 'Get weather',
  method: 'GET',
  url: 'https://api.example.com/weather/{{city}}',
  query: { units: 'metric', day: '{{day}}' },
  headers: { accept: 'application/json' },
  ...over,
})

test('endpointParams collects {{placeholders}} across url, query, headers and body in order', () => {
  const params = endpointParams(
    endpoint({
      method: 'POST',
      headers: { 'x-region': '{{region}}' },
      bodyMode: 'json',
      body: '{ "city": "{{city}}", "note": "{{note}}" }',
    }),
  )
  assert.deepEqual(params, ['city', 'day', 'region', 'note'])
})

test('fillEndpointTemplate substitutes values, URL-encoding where asked', () => {
  assert.equal(
    fillEndpointTemplate('https://api.example.com/weather/{{city}}', { city: 'San José' }, { encode: true }),
    'https://api.example.com/weather/San%20Jos%C3%A9',
  )
  assert.equal(fillEndpointTemplate('{ "city": "{{city}}" }', { city: 'Oslo' }), '{ "city": "Oslo" }')
  assert.equal(fillEndpointTemplate('{{missing}}', {}), '', 'missing args become empty strings, not literals')
})

test('endpointToolName slugifies the display name into a model-safe tool id', () => {
  assert.equal(endpointToolName(endpoint()), 'get_weather')
  assert.equal(endpointToolName(endpoint({ name: '  Sync CRM → Sheets!  ' })), 'sync_crm_sheets')
  assert.equal(endpointToolName(endpoint({ name: '!!!', id: 'abcdef123456' })), 'endpoint_abcdef12')
})

test('endpointToolDefinition exposes the placeholders as required typed inputs', () => {
  const def = endpointToolDefinition(endpoint({ description: 'Current weather by city' }))
  assert.equal(def.name, 'get_weather')
  assert.match(def.description, /Current weather by city/)
  assert.match(def.description, /GET https:\/\/api\.example\.com\/weather\/<city>/)
  const schema = def.inputSchema as { properties: Record<string, unknown>; required: string[] }
  assert.deepEqual(Object.keys(schema.properties), ['city', 'day'])
  assert.deepEqual(schema.required, ['city', 'day'])
})

test('parseAgentHttpEndpoints keeps valid rows and drops malformed ones', () => {
  const rows = parseAgentHttpEndpoints([
    endpoint(),
    { id: 'bad', name: '', method: 'GET', url: 'https://x.example' }, // empty name
    { nonsense: true },
    endpoint({ id: 'ep-2', name: 'Post note', method: 'POST', bodyMode: 'json', body: '{}' }),
  ])
  assert.deepEqual(rows.map((row) => row.id), ['ep-1', 'ep-2'])
})

test('the schema rejects oversized bodies and unknown methods', () => {
  assert.equal(agentHttpEndpointSchema.safeParse(endpoint({ method: 'TRACE' as never })).success, false)
  assert.equal(agentHttpEndpointSchema.safeParse(endpoint({ body: 'x'.repeat(20_001) })).success, false)
})

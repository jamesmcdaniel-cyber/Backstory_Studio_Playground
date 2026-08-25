import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isMcpEndpointUrl, mcpStepSuggestion, readJsonRpcCall } from '@/lib/flows/mcp-step-suggestion'

const connections = [
  { id: 'people_ai:backstory', name: 'Backstory', serverUrl: 'https://mcp.people.ai/mcp' },
  { id: 'conn_1', name: 'Notion', serverUrl: 'https://mcp.notion.com/mcp' },
]

const httpStep = (data: Record<string, unknown>) => ({ type: 'http', data })

/**
 * The real case: a POST to an MCP endpoint carrying a JSON-RPC envelope, with
 * the tool name buried in a body field and the arguments hand-written as JSON.
 * The Tool step is the same call as three controls.
 */

test('an MCP endpoint is recognised, an ordinary API is not', () => {
  assert.equal(isMcpEndpointUrl('https://mcp.people.ai/mcp'), true)
  assert.equal(isMcpEndpointUrl('https://example.com/mcp/'), true)
  assert.equal(isMcpEndpointUrl('https://mcp.notion.com/anything'), true)
  // Narrow on purpose: guessing wrong puts a "convert me" banner on a normal call.
  assert.equal(isMcpEndpointUrl('https://api.stripe.com/v1/charges'), false)
  assert.equal(isMcpEndpointUrl('https://example.com/mcpherson'), false)
  assert.equal(isMcpEndpointUrl(''), false)
  // A templated URL cannot be matched against a connection.
  assert.equal(isMcpEndpointUrl('{{steps.x.url}}'), false)
})

test('the tool name and arguments are read out of the JSON-RPC body', () => {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'top_records', arguments: { limit: 20 } },
  })
  assert.deepEqual(readJsonRpcCall(body), { toolName: 'top_records', args: '{\n  "limit": 20\n}' })
})

test('a body that is not a tools/call yields nothing', () => {
  assert.deepEqual(readJsonRpcCall(JSON.stringify({ method: 'tools/list' })), {})
  assert.deepEqual(readJsonRpcCall('not json'), {})
  assert.deepEqual(readJsonRpcCall(''), {})
  assert.deepEqual(readJsonRpcCall(undefined), {})
})

test('a templated body still offers the swap, just without a pre-filled action', () => {
  // `{{token}}` makes the body unparseable as JSON. Not offering the swap at
  // all would punish exactly the flows that wired their arguments up properly.
  const suggestion = mcpStepSuggestion(
    httpStep({ url: 'https://mcp.people.ai/mcp', body: '{"method":"tools/call","params":{"name":"{{steps.pick.tool}}"}}' }),
    connections,
  )
  assert.equal(suggestion?.connectionId, 'people_ai:backstory')
  assert.equal(suggestion?.toolName, undefined)
})

test('an MCP call over HTTP is matched to its connected server', () => {
  const suggestion = mcpStepSuggestion(
    httpStep({
      url: 'https://mcp.people.ai/mcp',
      body: JSON.stringify({ method: 'tools/call', params: { name: 'top_records', arguments: {} } }),
    }),
    connections,
  )
  assert.equal(suggestion?.connectionId, 'people_ai:backstory')
  assert.equal(suggestion?.connectionName, 'Backstory')
  assert.equal(suggestion?.toolName, 'top_records')
})

test('a trailing slash or different case still matches the same server', () => {
  const suggestion = mcpStepSuggestion(httpStep({ url: 'https://MCP.people.ai/mcp/' }), connections)
  assert.equal(suggestion?.connectionId, 'people_ai:backstory')
})

test('an MCP endpoint the workspace has NOT connected offers nothing', () => {
  // Converting to a connection that does not exist would swap a step that works
  // for one that cannot run.
  assert.equal(mcpStepSuggestion(httpStep({ url: 'https://mcp.someoneelse.com/mcp' }), connections), null)
})

test('nothing is suggested for an ordinary HTTP step, or a non-HTTP step', () => {
  assert.equal(mcpStepSuggestion(httpStep({ url: 'https://api.example.com/v1/things' }), connections), null)
  assert.equal(mcpStepSuggestion({ type: 'tool', data: { url: 'https://mcp.people.ai/mcp' } }, connections), null)
})

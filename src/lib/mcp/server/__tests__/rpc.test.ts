import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MCP_PROTOCOL_VERSION,
  RPC_INVALID_REQUEST,
  initializeResult,
  isNotification,
  parseRpcRequest,
  rpcError,
  rpcResult,
  toolResult,
} from '@/lib/mcp/server/rpc'

/**
 * Nothing in our own UI speaks this protocol, so every one of these shapes is
 * exercised only by other people's clients. That makes them the kind of thing
 * that is wrong once and then wrong forever.
 */

test('a well-formed request parses with its id and params', () => {
  const parsed = parseRpcRequest({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'x' } })
  assert.notEqual(typeof parsed, 'string')
  assert.deepEqual(parsed, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'x' } })
})

test('a notification is recognised by the ABSENCE of an id, not by a null one', () => {
  // `notifications/initialized` arrives with no id and must get no response.
  // A null id is a real id in JSON-RPC and does take one.
  const notification = parseRpcRequest({ jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.equal(isNotification(notification as never), true)

  const nullId = parseRpcRequest({ jsonrpc: '2.0', id: null, method: 'ping' })
  assert.equal(isNotification(nullId as never), false)
})

test('every malformed body is described, never thrown', () => {
  for (const body of [null, 'text', 42, [], { jsonrpc: '1.0', method: 'x' }, { jsonrpc: '2.0' }, { jsonrpc: '2.0', method: '' }]) {
    assert.equal(typeof parseRpcRequest(body), 'string', JSON.stringify(body))
  }
})

test('an id of the wrong type is rejected rather than coerced', () => {
  assert.equal(typeof parseRpcRequest({ jsonrpc: '2.0', id: { nested: true }, method: 'ping' }), 'string')
})

test('params must be an object — an array would be positional, which MCP does not use', () => {
  assert.equal(typeof parseRpcRequest({ jsonrpc: '2.0', id: 1, method: 'ping', params: [1, 2] }), 'string')
})

test('responses carry the id they answer, including a null one', () => {
  assert.deepEqual(rpcResult(null, { ok: true }), { jsonrpc: '2.0', id: null, result: { ok: true } })
  assert.deepEqual(rpcError(3, RPC_INVALID_REQUEST, 'bad'), {
    jsonrpc: '2.0',
    id: 3,
    error: { code: RPC_INVALID_REQUEST, message: 'bad' },
  })
})

test('the handshake advertises tools and a protocol version', () => {
  const result = initializeResult('backstory', '1.0.0')
  assert.equal(result.protocolVersion, MCP_PROTOCOL_VERSION)
  assert.deepEqual(result.capabilities.tools, { listChanged: false })
  assert.equal(result.serverInfo.name, 'backstory')
})

test('a failed tool call is a RESULT, not a transport error', () => {
  // A model can read `isError` and try something else; a JSON-RPC error looks
  // like the connection is broken and ends the conversation.
  const failure = toolResult('That flow needs an account name.', true)
  assert.equal(failure.isError, true)
  assert.equal(failure.content[0].text, 'That flow needs an account name.')

  const ok = toolResult({ flowRunId: 'r1' })
  assert.equal('isError' in ok, false)
  assert.equal(JSON.parse(ok.content[0].text).flowRunId, 'r1')
})

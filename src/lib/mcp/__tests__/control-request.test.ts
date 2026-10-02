import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchMcpControlRequest } from '../control-request'

test('transient initialized notification failure recovers within its original deadline', async () => {
  let calls = 0
  const signal = AbortSignal.timeout(2000)
  const response = await fetchMcpControlRequest('https://example.com', 'notifications/initialized', { signal }, async (_url, init) => {
    assert.equal(init?.signal, signal)
    return new Response(null, { status: ++calls === 1 ? 502 : 202 })
  })
  assert.equal(response.status, 202)
  assert.equal(calls, 2)
})

test('control retries are bounded and authentication failures are not retried', async () => {
  for (const status of [503, 401]) {
    let calls = 0
    const response = await fetchMcpControlRequest('https://example.com', 'tools/list', {}, async () => { calls++; return new Response(null, { status }) })
    assert.equal(response.status, status)
    assert.equal(calls, status === 503 ? 3 : 1)
  }
})

test('tool invocations are never replayed even on gateway failures', async () => {
  let calls = 0
  const response = await fetchMcpControlRequest('https://example.com', 'tools/call', {}, async () => { calls++; return new Response(null, { status: 502 }) })
  assert.equal(response.status, 502)
  assert.equal(calls, 1)
})

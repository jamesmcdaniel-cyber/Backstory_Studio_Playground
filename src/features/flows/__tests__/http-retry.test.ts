import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runHttpWithRetries } from '../http-retry'
import type { FlowHttpOutput } from '../http'

/**
 * The bug: http.ts returns non-2xx as a VALUE (`{ok:false,status}`) and never
 * throws, so runWithRetries never saw a 429 or a 503 — the one class of failure
 * retry is unambiguously for — while permanent auth failures on the tool path
 * did consume the whole budget.
 *
 * The constraint: flows branch on that returned value. `retries = 0` must stay
 * byte-identical, which the pinning test below is here to guarantee.
 */

function response(status: number, headers: Record<string, string> = {}): FlowHttpOutput {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    url: 'https://example.test/x',
    headers,
    body: { status },
    bodyText: String(status),
  }
}

/** Returns a scripted sequence, repeating the last entry once exhausted. */
function scripted(statuses: Array<number | { status: number; headers: Record<string, string> }>) {
  const calls: number[] = []
  let index = 0
  const run = async () => {
    const entry = statuses[Math.min(index, statuses.length - 1)]
    index += 1
    const status = typeof entry === 'number' ? entry : entry.status
    const headers = typeof entry === 'number' ? {} : entry.headers
    calls.push(status)
    return response(status, headers)
  }
  return { calls, run }
}

/** No real sleeping in any of these. */
const fast = { sleep: async () => undefined, now: () => 0 }

test('PINNED: retries=0 behaves exactly as before for 200, 404, 429, and 503', async () => {
  for (const status of [200, 404, 429, 503]) {
    const http = scripted([status])
    const result = await runHttpWithRetries(http.run, { retries: 0, ...fast })
    assert.equal(result.status, status, `status ${status} must come back unchanged`)
    assert.equal(http.calls.length, 1, `status ${status} must be called exactly once`)
  }
})

test('a retryable 503 with retries=2 retries twice, then returns the response', async () => {
  const http = scripted([503])
  const result = await runHttpWithRetries(http.run, { retries: 2, retryDelayMs: 0, ...fast })
  assert.equal(http.calls.length, 3)
  assert.equal(result.status, 503)
  assert.equal(result.ok, false)
})

test('a 429 that then succeeds returns the success and stops retrying', async () => {
  const http = scripted([429, 200])
  const result = await runHttpWithRetries(http.run, { retries: 3, retryDelayMs: 0, ...fast })
  assert.equal(http.calls.length, 2)
  assert.equal(result.status, 200)
  assert.equal(result.ok, true)
})

test('a 404 with retries=3 is NOT retried — terminal', async () => {
  const http = scripted([404])
  const result = await runHttpWithRetries(http.run, { retries: 3, retryDelayMs: 0, ...fast })
  assert.equal(http.calls.length, 1)
  assert.equal(result.status, 404)
})

test('a 401 with retries=3 is NOT retried — bad credentials never fix themselves', async () => {
  const http = scripted([401])
  const result = await runHttpWithRetries(http.run, { retries: 3, retryDelayMs: 0, ...fast })
  assert.equal(http.calls.length, 1)
  assert.equal(result.status, 401)
})

test('the exhausted response is returned, never thrown — flows branch on it', async () => {
  const http = scripted([503])
  const result = await runHttpWithRetries(http.run, { retries: 1, retryDelayMs: 0, ...fast })
  assert.equal(result.ok, false)
  assert.equal(result.status, 503)
  assert.deepEqual(result.body, { status: 503 })
})

test("a provider's Retry-After drives the wait", async () => {
  const delays: number[] = []
  const http = scripted([{ status: 429, headers: { 'retry-after': '2' } }, 200])
  const result = await runHttpWithRetries(http.run, {
    retries: 2,
    retryDelayMs: 10_000,
    sleep: async (ms: number) => {
      delays.push(ms)
    },
    now: () => 0,
  })
  assert.equal(result.status, 200)
  assert.deepEqual(delays, [2_000], "the provider's 2s beats the 10s base backoff")
})

test('a genuine transport error still throws rather than being swallowed', async () => {
  await assert.rejects(
    runHttpWithRetries(
      async () => {
        throw new Error('ECONNREFUSED')
      },
      { retries: 0, ...fast },
    ),
    /ECONNREFUSED/,
  )
})

test('a transport error carrying a status property is not mistaken for a response', async () => {
  // The removed "last response" fallback would have swallowed this.
  await assert.rejects(
    runHttpWithRetries(
      async () => {
        throw Object.assign(new Error('socket hang up'), { status: 503 })
      },
      { retries: 0, ...fast },
    ),
    /socket hang up/,
  )
})

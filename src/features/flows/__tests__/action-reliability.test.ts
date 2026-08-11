import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  flowActionRetries,
  flowActionTimeoutMs,
  runWithRetries,
  withTimeout,
  shouldRetryAfterTimeout,
  classifyRetry,
  retryBackoffMs,
  parseRetryAfter,
  FlowTimeoutError,
  RETRY_MAX_DELAY_MS,
} from '../action-reliability'

test('flow action reliability clamps retries and timeouts', () => {
  assert.equal(flowActionRetries(8), 5)
  assert.equal(flowActionRetries(-2), 0)
  assert.equal(flowActionRetries('2'), 0)
  assert.equal(flowActionTimeoutMs(10), 1000)
  assert.equal(flowActionTimeoutMs(999999), 120000)
  assert.equal(flowActionTimeoutMs('30'), undefined)
})

test('runWithRetries retries failed attempts before succeeding', async () => {
  let attempts = 0
  const result = await runWithRetries(async () => {
    attempts += 1
    if (attempts < 3) throw new Error('temporary failure')
    return 'ok'
  }, { retries: 2, retryDelayMs: 0 })
  assert.equal(result, 'ok')
  assert.equal(attempts, 3)
})

test('withTimeout surfaces the timeout message', async () => {
  await assert.rejects(
    withTimeout(new Promise((resolve) => setTimeout(() => resolve('late'), 30)), 1, 'tool timed out'),
    /tool timed out/,
  )
})

test('only http steps may retry after a timeout — agent/tool/ai executions stay live when abandoned', () => {
  assert.equal(shouldRetryAfterTimeout('agent'), false)
  assert.equal(shouldRetryAfterTimeout('tool'), false)
  assert.equal(shouldRetryAfterTimeout('ai'), false)
  assert.equal(shouldRetryAfterTimeout('http'), true)
})

test('runWithRetries with retryOnTimeout=false fails on the first timeout without a second attempt', async () => {
  let attempts = 0
  await assert.rejects(
    runWithRetries(
      async () => {
        attempts += 1
        // Never resolves: simulates an abandoned live call (no lingering timer).
        return new Promise<string>(() => {})
      },
      { retries: 3, timeoutMs: 1000, timeoutMessage: 'call timed out', retryDelayMs: 0, retryOnTimeout: false },
    ),
    /call timed out/,
  )
  assert.equal(attempts, 1)
})

test('runWithRetries with retryOnTimeout=false still retries hard errors', async () => {
  let attempts = 0
  const result = await runWithRetries(
    async () => {
      attempts += 1
      if (attempts < 2) throw new Error('temporary failure')
      return 'ok'
    },
    { retries: 2, timeoutMs: 5000, retryDelayMs: 0, retryOnTimeout: false },
  )
  assert.equal(result, 'ok')
  assert.equal(attempts, 2)
})

// ---------------------------------------------------------------------------
// WS3: retry that distinguishes what it is retrying.
//
// The old loop slept a constant 500ms and treated every failure alike, so five
// retries were five hits in 2.5s (in lockstep across a per-item loop), a 401
// burned the full budget on something that could never succeed, and — because
// the HTTP step returns non-2xx as a VALUE rather than throwing — a 429 or 503
// never reached the retry path at all.
// ---------------------------------------------------------------------------

test('5xx, 429, and 408 are retryable', () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(classifyRetry(new Error('x'), status), 'retryable', `status ${status}`)
  }
})

test('auth and validation failures are terminal — retrying them only burns budget', () => {
  for (const status of [400, 401, 403, 404, 405, 409, 410, 422]) {
    assert.equal(classifyRetry(new Error('x'), status), 'terminal', `status ${status}`)
  }
})

test('an unmapped 4xx is terminal, an unmapped 5xx is retryable', () => {
  assert.equal(classifyRetry(new Error('x'), 418), 'terminal')
  assert.equal(classifyRetry(new Error('x'), 599), 'retryable')
})

test('a timeout classifies as timeout, so the per-kind policy still governs it', () => {
  assert.equal(classifyRetry(new FlowTimeoutError('slow')), 'timeout')
})

test('an unrecognized error stays retryable — the pre-existing default', () => {
  assert.equal(classifyRetry(new Error('ECONNRESET')), 'retryable')
  assert.equal(classifyRetry('something odd'), 'retryable')
  assert.equal(classifyRetry(null), 'retryable')
})

test('a status carried on the error object is read when none is passed', () => {
  const error = Object.assign(new Error('nope'), { status: 401 })
  assert.equal(classifyRetry(error), 'terminal')
})

test('backoff grows exponentially and caps', () => {
  const noJitter = () => 1
  assert.equal(retryBackoffMs(0, 500, noJitter), 500)
  assert.equal(retryBackoffMs(1, 500, noJitter), 1_000)
  assert.equal(retryBackoffMs(2, 500, noJitter), 2_000)
  assert.equal(retryBackoffMs(20, 500, noJitter), RETRY_MAX_DELAY_MS)
})

test('jitter stays within [0.5, 1.0] of the computed delay', () => {
  assert.equal(retryBackoffMs(1, 500, () => 0), 500)
  assert.equal(retryBackoffMs(1, 500, () => 1), 1_000)
})

test('a zero base still yields zero, so retryDelayMs:0 stays instant in tests', () => {
  assert.equal(retryBackoffMs(3, 0, () => 1), 0)
})

test('Retry-After in delta-seconds parses to milliseconds', () => {
  assert.equal(parseRetryAfter('30'), 30_000)
  assert.equal(parseRetryAfter('0'), 0)
})

test('Retry-After as an HTTP-date parses relative to now', () => {
  const now = Date.parse('2026-08-11T09:00:00.000Z')
  assert.equal(parseRetryAfter('Tue, 11 Aug 2026 09:00:30 GMT', now), 30_000)
})

test('a past or unparseable Retry-After yields 0 or null, never a negative delay', () => {
  const now = Date.parse('2026-08-11T09:00:00.000Z')
  assert.equal(parseRetryAfter('Tue, 11 Aug 2026 08:59:00 GMT', now), 0)
  assert.equal(parseRetryAfter('gibberish', now), null)
  assert.equal(parseRetryAfter(null, now), null)
})

test('a terminal error consumes exactly one attempt', async () => {
  let calls = 0
  await assert.rejects(
    runWithRetries(
      async () => {
        calls += 1
        throw Object.assign(new Error('unauthorized'), { status: 401 })
      },
      { retries: 3, retryDelayMs: 0 },
    ),
  )
  assert.equal(calls, 1)
})

test('a retryable error uses the whole budget', async () => {
  let calls = 0
  await assert.rejects(
    runWithRetries(
      async () => {
        calls += 1
        throw Object.assign(new Error('unavailable'), { status: 503 })
      },
      { retries: 2, retryDelayMs: 0 },
    ),
  )
  assert.equal(calls, 3)
})

test('retries=0 still means exactly one attempt', async () => {
  let calls = 0
  await assert.rejects(
    runWithRetries(
      async () => {
        calls += 1
        throw new Error('x')
      },
      { retries: 0 },
    ),
  )
  assert.equal(calls, 1)
})

test('a provider Retry-After overrides the computed backoff', async () => {
  const delays: number[] = []
  let calls = 0
  await assert.rejects(
    runWithRetries(
      async () => {
        calls += 1
        throw Object.assign(new Error('slow down'), { status: 429, retryAfterMs: 25 })
      },
      {
        retries: 1,
        retryDelayMs: 10_000,
        retryAfterMs: (error) => (error as { retryAfterMs?: number }).retryAfterMs ?? null,
        sleep: async (ms: number) => {
          delays.push(ms)
        },
      },
    ),
  )
  assert.equal(calls, 2)
  assert.deepEqual(delays, [25], 'the 25ms provider hint must beat the 10s base backoff')
})

test('the total-elapsed cap stops a chain rather than sleeping past the step timeout', async () => {
  let calls = 0
  let clock = 0
  await assert.rejects(
    runWithRetries(
      async () => {
        calls += 1
        // A slow operation: 40s per attempt, so the elapsed budget is consumed
        // by the WORK, not only by the waiting. This is the realistic shape —
        // and it makes the assertion independent of jitter.
        clock += 40_000
        throw Object.assign(new Error('unavailable'), { status: 503 })
      },
      {
        retries: 5,
        retryDelayMs: 30_000,
        now: () => clock,
        sleep: async (ms: number) => {
          clock += ms
        },
      },
    ),
  )
  // 40s of work + a capped 30s wait, against a 120s budget: the chain must stop
  // well before its 6th attempt rather than sleeping past the step timeout and
  // letting BullMQ declare the job stalled mid-wait.
  assert.ok(calls > 1, 'it should still retry at least once')
  assert.ok(calls < 5, `expected the elapsed cap to cut the chain short, got ${calls} attempts`)
})

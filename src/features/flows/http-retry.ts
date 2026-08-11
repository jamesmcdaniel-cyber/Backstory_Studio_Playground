import { runWithRetries, classifyRetry, parseRetryAfter, shouldRetryAfterTimeout } from './action-reliability'
import type { FlowHttpOutput } from './http'

/**
 * Make a retryable HTTP status actually reach the retry loop.
 *
 * The HTTP step returns non-2xx as a VALUE (`{ ok: false, status }`) rather
 * than throwing, and flows branch on that value — so `retries` never saw a 429
 * or a 503, the exact failures it exists for, while permanent auth failures on
 * the tool path did consume the budget. This converts a retryable status into a
 * throw INTERNALLY so the loop can see it, then converts the exhausted failure
 * back into the response object callers have always received.
 *
 * COMPATIBILITY CONTRACT, pinned by test:
 *  - `retries === 0` is a pass-through. Identical to the old behavior for every
 *    status, so no existing flow changes.
 *  - a non-retryable status returns immediately, as before.
 *  - a retryable status with budget left is retried, honoring Retry-After.
 *  - when the budget is exhausted the RESPONSE is returned, never thrown.
 */

/** Carries the response through the retry loop as a throwable. */
class RetryableStatus extends Error {
  readonly status: number
  constructor(readonly response: FlowHttpOutput) {
    super(`HTTP ${response.status}`)
    this.status = response.status
  }
}

export async function runHttpWithRetries(
  operation: (attempt: number) => Promise<FlowHttpOutput>,
  options: {
    retries?: number
    retryDelayMs?: number
    timeoutMs?: number
    timeoutMessage?: string
    sleep?: (ms: number) => Promise<unknown>
    now?: () => number
  } = {},
): Promise<FlowHttpOutput> {
  try {
    return await runWithRetries(
      async (attempt) => {
        const response = await operation(attempt)
        if (!response.ok && classifyRetry(null, response.status) === 'retryable') {
          throw new RetryableStatus(response)
        }
        return response
      },
      {
        ...options,
        // HTTP timeouts abort the request (AbortController), so retrying them
        // cannot stack live work — the existing per-kind policy.
        retryOnTimeout: shouldRetryAfterTimeout('http'),
        retryAfterMs: (error) =>
          error instanceof RetryableStatus ? parseRetryAfter(error.response.headers?.['retry-after'] ?? null) : null,
      },
    )
  } catch (error) {
    // Budget exhausted on a retryable status: hand back the response, exactly
    // as the caller has always received it. ONLY RetryableStatus is converted —
    // a genuine transport error still throws, as it always did. Do not add a
    // "last response" fallback here: it would swallow real errors that happen
    // to carry a `status` property.
    if (error instanceof RetryableStatus) return error.response
    throw error
  }
}

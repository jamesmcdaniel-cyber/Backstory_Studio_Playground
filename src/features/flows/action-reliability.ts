import { truncateError } from '@/lib/flows/truncate'

const DEFAULT_RETRY_DELAY_MS = 500

/** Delay ceiling for one wait between attempts. */
export const RETRY_MAX_DELAY_MS = 30_000
/**
 * Ceiling on TOTAL time spent retrying one step, so a chain can never outrun the
 * step's own timeout or the BullMQ job lock and get the run declared stalled
 * while it sleeps.
 */
export const RETRY_MAX_ELAPSED_MS = 120_000

function sleepMs(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Thrown by withTimeout so callers can tell a timeout from a hard failure. */
export class FlowTimeoutError extends Error {}

/**
 * Retry-after-TIMEOUT policy per step kind (hard errors always retry up to
 * `retries`). Agent, tool, and ai timeouts merely ABANDON the in-flight call —
 * Promise.race / withTimeout cannot cancel it — so the first execution may
 * still be running; retrying would spawn a second concurrent execution
 * (double token spend, duplicate side effects — same reasoning as tool: a
 * single-turn model call has no cancellation hook either). HTTP timeouts
 * abort the request itself (AbortController), so retrying them cannot stack
 * live work.
 */
export function shouldRetryAfterTimeout(kind: 'agent' | 'tool' | 'http' | 'ai' | 'subflow'): boolean {
  return kind === 'http'
}

export function flowActionRetries(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(5, Math.round(value)))
    : 0
}

export function flowActionTimeoutMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1000, Math.min(120000, Math.round(value)))
    : undefined
}

/**
 * Statuses worth retrying: transient congestion, rate limits, and server-side
 * faults. 425 (Too Early) belongs here too — it explicitly invites a retry.
 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
/**
 * Statuses that will never succeed on repeat: bad credentials, missing
 * resources, failed validation. Retrying these burned the whole budget on a
 * foregone conclusion and hammered the provider on the way.
 */
const TERMINAL_STATUS = new Set([400, 401, 403, 404, 405, 409, 410, 422])

function statusOf(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error) {
    const value = (error as { status: unknown }).status
    if (typeof value === 'number') return value
  }
  return undefined
}

/**
 * What KIND of failure this is.
 *
 * Retrying a 401 exactly like a 503 is the bug: one is a foregone conclusion,
 * the other is precisely what retry exists for. Unknown failures stay
 * `retryable` because that is the pre-existing default — narrowing it would
 * silently stop retrying transport errors we do not model.
 */
export function classifyRetry(error: unknown, status?: number): 'retryable' | 'terminal' | 'timeout' {
  if (error instanceof FlowTimeoutError) return 'timeout'
  const code = status ?? statusOf(error)
  if (code !== undefined) {
    if (TERMINAL_STATUS.has(code)) return 'terminal'
    if (RETRYABLE_STATUS.has(code)) return 'retryable'
    // Unmapped 4xx is a client error: repeating it changes nothing.
    if (code >= 400 && code < 500) return 'terminal'
  }
  return 'retryable'
}

/**
 * Exponential backoff with jitter.
 *
 * The old fixed 500ms meant five retries were five hits in 2.5 seconds, and —
 * worse — every iteration of a per-item loop retried in lockstep, so a
 * struggling API got a synchronized burst instead of a spread one. Jitter is
 * what de-synchronizes them.
 */
export function retryBackoffMs(attempt: number, baseMs: number, random: () => number = Math.random): number {
  const exponential = Math.min(baseMs * 2 ** attempt, RETRY_MAX_DELAY_MS)
  return Math.round(exponential * (0.5 + random() * 0.5))
}

/** `Retry-After` as milliseconds: delta-seconds or HTTP-date. Null if absent/unparseable. */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | null {
  if (!header) return null
  const trimmed = header.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return null
  // Never negative: a Retry-After already in the past means "go now".
  return Math.max(0, at - now)
}

export async function withTimeout<T>(operation: Promise<T>, timeoutMs: number | undefined, timeoutMessage: string): Promise<T> {
  if (!timeoutMs) return operation
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new FlowTimeoutError(timeoutMessage)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Extra properties attached to the error thrown when the retry budget is
 *  exhausted, so a caller who only has the caught error can still recover
 *  the full retry evidence trail (used to persist step warnings). */
export type RetryEvidenceError = Error & { attempts?: number; attemptErrors?: string[] }

export async function runWithRetries<T>(
  operation: (attempt: number) => Promise<T>,
  options: {
    retries?: number
    timeoutMs?: number
    timeoutMessage?: string
    retryDelayMs?: number
    // When false, a timeout is terminal: withTimeout only abandons the live
    // operation, so retrying could run it a second time concurrently. Hard
    // errors still retry. Defaults to true (existing behavior) — pass
    // shouldRetryAfterTimeout(kind) to apply the per-step-kind policy.
    retryOnTimeout?: boolean
    /**
     * Provider-supplied delay for the NEXT attempt, in ms (typically parsed
     * from a Retry-After header). Overrides the computed backoff — a provider
     * telling us exactly when to come back beats our guess.
     */
    retryAfterMs?: (error: unknown) => number | null
    /** Test seams: injected so backoff assertions do not sleep in real time. */
    sleep?: (ms: number) => Promise<unknown>
    now?: () => number
  } = {},
): Promise<{ result: T; attempts: number; attemptErrors: string[] }> {
  const retries = flowActionRetries(options.retries)
  const timeoutMs = flowActionTimeoutMs(options.timeoutMs)
  const base = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const sleep = options.sleep ?? sleepMs
  const clock = options.now ?? Date.now
  const startedAt = clock()
  // Ceiling on total attempts this call could ever make — fixed up front so
  // every pushed string names the same denominator regardless of when the
  // chain stops (terminal error, timeout policy, or elapsed budget).
  const max = retries + 1
  // Every failed attempt's evidence, in order — a retry that eventually
  // succeeds is otherwise invisible (only the last error used to survive).
  const attemptErrors: string[] = []
  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const result = await withTimeout(
        operation(attempt),
        timeoutMs,
        options.timeoutMessage ?? `Step timed out after ${timeoutMs}ms`,
      )
      return { result, attempts: attemptErrors.length + 1, attemptErrors }
    } catch (error) {
      lastError = error
      attemptErrors.push(`attempt ${attempt + 1}/${max} failed: ${truncateError(error)}`)
      if (attempt >= retries) break
      const kind = classifyRetry(error)
      // A timeout only ABANDONS the in-flight call; the per-kind policy decides
      // whether retrying could stack a second live execution. Unchanged.
      if (kind === 'timeout' && options.retryOnTimeout === false) break
      // No amount of waiting fixes a 401 or a 422.
      if (kind === 'terminal') break
      const suggested = options.retryAfterMs?.(error) ?? null
      const delay = Math.min(suggested ?? retryBackoffMs(attempt, base), RETRY_MAX_DELAY_MS)
      // Stop rather than sleep past the budget: an over-long chain would blow
      // the step timeout or let BullMQ declare the job stalled mid-wait.
      if (clock() - startedAt + delay > RETRY_MAX_ELAPSED_MS) break
      await sleep(delay)
    }
  }
  const finalError: RetryEvidenceError = lastError instanceof Error ? lastError : new Error(String(lastError))
  finalError.attempts = attemptErrors.length
  finalError.attemptErrors = attemptErrors
  throw finalError
}

/**
 * Error reporting seam.
 *
 * `captureError` is safe to call anywhere on the server: with SENTRY_DSN set
 * (and initSentry() run from instrumentation.ts) errors go to Sentry; without
 * it they fall back to structured console output. A reporter can be injected
 * for tests. Reporting must never throw into the caller.
 */

type ErrorReporter = (error: unknown, context?: Record<string, unknown>) => void

let reporter: ErrorReporter | null = null

export function setErrorReporter(next: ErrorReporter): void {
  reporter = next
}

type ErrorFlusher = (timeoutMs: number) => Promise<void>

let flusher: ErrorFlusher | null = null

/** Test seam: inject a flusher the way setErrorReporter injects a reporter. */
export function setErrorFlusher(next: ErrorFlusher): void {
  flusher = next
}

export function resetErrorReporter(): void {
  reporter = null
  flusher = null
}

export function captureError(error: unknown, context?: Record<string, unknown>): void {
  try {
    if (reporter) {
      reporter(error, context)
      return
    }
    console.error('[error]', context ?? {}, error)
  } catch {
    // Reporting must never take the request down with it.
  }
}

/**
 * Drain any queued error reports (Sentry buffers sends). Call before a
 * deliberate process exit — without it, the last errors of a worker's life
 * are exactly the ones that get dropped. Safe no-op when never initialized.
 */
export async function flushErrorReporting(timeoutMs = 2000): Promise<void> {
  if (!flusher) return
  try {
    await flusher(timeoutMs)
  } catch {
    // Flushing is best-effort; never take shutdown down with it.
  }
}

/**
 * Initialize Sentry server-side and route captureError through it.
 * `processTag` distinguishes web (Next.js) from the standalone worker in the
 * Sentry UI. Never throws: an observability failure must not stop the process.
 */
export async function initSentry(processTag = 'web'): Promise<void> {
  const dsn = process.env.SENTRY_DSN
  if (!dsn) return
  try {
    const Sentry = await import('@sentry/nextjs')
    Sentry.init({
      dsn,
      environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
      tracesSampleRate: 0,
      // A configured OTLP provider owns the process-wide OpenTelemetry API.
      // Sentry remains the error plane and must not install a competing global
      // provider/context manager.
      skipOpenTelemetrySetup: Boolean(
        !/^(1|true|yes)$/i.test(process.env.OTEL_SDK_DISABLED ?? '') &&
        (process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT),
      ),
    })
    Sentry.setTag('process', processTag)
    setErrorReporter((error, context) => {
      Sentry.captureException(error, context ? { extra: context } : undefined)
    })
    setErrorFlusher(async (timeoutMs) => {
      await Sentry.flush(timeoutMs)
    })
  } catch (error) {
    console.error('[sentry] init failed; falling back to console reporting', error)
  }
}

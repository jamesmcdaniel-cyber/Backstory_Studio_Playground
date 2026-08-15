import { redactLogMeta } from '@/lib/logging/redact'

/**
 * Every `meta` object is redacted before it reaches the console.
 *
 * This used to be a bare `console.*` wrapper, which meant credentials stayed
 * out of the platform log only because each of the ~117 call sites happened not
 * to pass one. The redaction is applied HERE rather than asked of call sites,
 * so the guarantee holds for code that has not been written yet — see
 * src/lib/logging/redact.ts for what it catches and what it deliberately keeps.
 */
export const apiLogger = {
  error(message: string, meta?: Record<string, unknown>) {
    console.error(`[api] ${message}`, meta ? redactLogMeta(meta) : '')
  },
  warn(message: string, meta?: Record<string, unknown>) {
    console.warn(`[api] ${message}`, meta ? redactLogMeta(meta) : '')
  },
  info(message: string, meta?: Record<string, unknown>) {
    console.log(`[api] ${message}`, meta ? redactLogMeta(meta) : '')
  },
}

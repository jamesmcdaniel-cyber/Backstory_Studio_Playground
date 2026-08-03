/**
 * Central server environment validation.
 *
 * `assertServerEnv()` runs once at server startup (instrumentation.ts) and
 * throws a single aggregated error naming every missing required variable, so
 * a misconfigured deploy fails loudly at boot instead of 500ing per-request.
 *
 * Required in production only — development stays permissive so a fresh clone
 * can boot without a full env file.
 */

const REQUIRED_IN_PRODUCTION = [
  'DATABASE_URL',
  'DIRECT_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'ENCRYPTION_KEY',
  'FILE_SCAN_URL',
] as const

/** At least one model provider key must be present for agent runs. Claude
 *  (Anthropic) is the default; Qwen is the OpenAI-compatible alternative. */
const MODEL_KEYS = ['ANTHROPIC_API_KEY', 'QWEN_API_KEY'] as const

export function assertServerEnv(): void {
  if (process.env.NODE_ENV !== 'production') return

  const missing = REQUIRED_IN_PRODUCTION.filter((name) => !process.env[name])

  const hasModelKey = MODEL_KEYS.some((name) => Boolean(process.env[name]))
  if (!hasModelKey) {
    missing.push(`one of ${MODEL_KEYS.join(' or ')}` as never)
  }

  const hasSharedRateLimitBackend = Boolean(
    process.env.REDIS_URL ||
    (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN),
  )
  if (!hasSharedRateLimitBackend) {
    missing.push('REDIS_URL or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN' as never)
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'Set them in the deployment environment before starting the server.',
    )
  }
}

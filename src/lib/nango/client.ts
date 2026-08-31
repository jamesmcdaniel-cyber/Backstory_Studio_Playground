import { Nango } from '@nangohq/node'
import { ApiError } from '@/lib/server/api-handler'

/**
 * Nango credentials.
 *
 * Nango SPLIT its single environment secret into two credentials, and
 * environments created after 2026-04-20 (or any that rotated their key) are
 * issued only the new pair — there is no "secret key" in their dashboard at
 * all:
 *
 *  - an API KEY, which authorizes API calls and is SCOPED (an account API key
 *    without `environment:integrations:list` authenticates fine and then 403s
 *    on the integrations grid), and
 *  - a WEBHOOK SIGNING KEY, which signs webhook deliveries. Nango never signs
 *    with the API key, so verification needs this value specifically.
 *
 * The deprecated `secretKey` did both jobs, which is why one env var used to be
 * enough. Both models are supported here:
 *
 *  - NANGO_API_KEY              — preferred. The API key.
 *  - NANGO_WEBHOOK_SIGNING_KEY  — preferred. Verifies webhook HMACs.
 *  - NANGO_SECRET_KEY           — legacy single secret; used for BOTH when the
 *                                 pair above is absent, preserving existing
 *                                 deployments exactly as they were.
 *
 * Optional: NANGO_HOST (self-hosted / regional API host; defaults to Nango Cloud).
 *
 * Env vars are read at call time (never at module load) so the Next.js build
 * succeeds even when they are not set.
 */
export function nangoApiKey(): string | undefined {
  return process.env.NANGO_API_KEY || process.env.NANGO_SECRET_KEY
}

/**
 * The value webhook HMACs are verified against. Falls back to the legacy
 * secret key, which DID sign webhooks — so an environment still on the old
 * single secret keeps working untouched.
 */
export function nangoWebhookSigningKey(): string | undefined {
  return process.env.NANGO_WEBHOOK_SIGNING_KEY || process.env.NANGO_SECRET_KEY
}

export function getNangoClient(): Nango {
  const apiKey = nangoApiKey()
  if (!apiKey) {
    // Throw the typed error rather than a bare one. `nangoApiError` already
    // maps "not configured" to a 503, but every route builds the client OUTSIDE
    // the try/catch that applies it — so a workspace without a Nango key got
    // "Internal server error" from the connections, verify, integrations
    // and session-token routes instead of an actionable message.
    throw new ApiError('Nango is not configured for this environment.', 503, 'NANGO_UNAVAILABLE')
  }
  const host = process.env.NANGO_HOST
  const webhookSigningKey = nangoWebhookSigningKey()
  // Always `apiKey`, never `secretKey`: the SDK throws if given both, and
  // `secretKey` is deprecated. webhookSigningKey is passed separately because
  // the SDK will NOT fall back to the api key for signature verification —
  // omitting it makes every webhook fail to verify.
  return new Nango({
    apiKey,
    ...(webhookSigningKey ? { webhookSigningKey } : {}),
    ...(host ? { host } : {}),
  })
}

export function nangoConfigured(): boolean {
  return Boolean(nangoApiKey())
}

/**
 * Tag written onto every connect session so connections can be listed and
 * authorized per organization.
 */
export const NANGO_ORG_TAG = 'org_id'

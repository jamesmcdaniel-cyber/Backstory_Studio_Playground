import { Nango } from '@nangohq/node'
import { ApiError } from '@/lib/server/api-handler'

/**
 * Creates a configured Nango backend client using env vars.
 * Required env vars:
 *  - NANGO_SECRET_KEY (environment secret key from the Nango dashboard)
 * Optional env vars:
 *  - NANGO_HOST (self-hosted / regional API host; defaults to Nango Cloud)
 *
 * Env vars are read at call time (never at module load) so the Next.js build
 * succeeds even when they are not set.
 */
export function getNangoClient(): Nango {
  const secretKey = process.env.NANGO_SECRET_KEY
  if (!secretKey) {
    // Throw the typed error rather than a bare one. `nangoApiError` already
    // maps "not configured" to a 503, but every route builds the client OUTSIDE
    // the try/catch that applies it — so a workspace without NANGO_SECRET_KEY
    // got "Internal server error" from the connections, verify, integrations
    // and session-token routes instead of an actionable message.
    throw new ApiError('Nango is not configured for this environment.', 503, 'NANGO_UNAVAILABLE')
  }
  const host = process.env.NANGO_HOST
  return new Nango({ secretKey, ...(host ? { host } : {}) })
}

export function nangoConfigured(): boolean {
  return Boolean(process.env.NANGO_SECRET_KEY)
}

/**
 * Tag written onto every connect session so connections can be listed and
 * authorized per organization.
 */
export const NANGO_ORG_TAG = 'org_id'

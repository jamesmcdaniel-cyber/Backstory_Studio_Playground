/**
 * Which authenticated capabilities this run actually has, and — when it has
 * none — the exact sentence explaining why.
 *
 * Every gate here returns a REASON string rather than a boolean, because the
 * failure mode this whole suite exists to prevent is a silent one: a spec that
 * quietly stops running looks identical, in a green pipeline, to a spec that
 * passed. `test.skip(condition, reason)` is only loud if the reason names the
 * missing variable, so the reasons are built here once and reused everywhere.
 */

/** Path of the storage state the auth setup project writes. */
export const STORAGE_STATE = 'e2e/.auth/user.json'

/** Set by the auth setup project when it could NOT establish a session. */
export const AUTH_MARKER = 'e2e/.auth/status.json'

function trimmed(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value || undefined
}

/**
 * The Supabase project the app under test authenticates against.
 *
 * Falls back to the NEXT_PUBLIC_* pair so a developer who already has a working
 * .env.local does not have to restate it, but the E2E_* names win: pointing the
 * browser suite at a throwaway project must never require editing the variables
 * the local dev server reads.
 */
export function supabaseTarget(): { url: string; anonKey: string } | null {
  const url = trimmed('E2E_SUPABASE_URL') ?? trimmed('NEXT_PUBLIC_SUPABASE_URL')
  const anonKey = trimmed('E2E_SUPABASE_ANON_KEY') ?? trimmed('NEXT_PUBLIC_SUPABASE_ANON_KEY')
  if (!url || !anonKey) return null
  return { url, anonKey }
}

export function testUserCredentials(): { email: string; password: string } | null {
  const email = trimmed('E2E_USER_EMAIL')
  const password = trimmed('E2E_USER_PASSWORD')
  if (!email || !password) return null
  return { email, password }
}

/**
 * Why an authenticated session cannot be minted, or null when it can.
 *
 * Named variables, not "missing configuration": whoever reads this in a CI
 * annotation is the person who has to set them, and a vague reason costs them a
 * round-trip through the repository to find out which.
 */
export function authSkipReason(): string | null {
  const missing: string[] = []
  if (!testUserCredentials()) missing.push('E2E_USER_EMAIL + E2E_USER_PASSWORD')
  if (!supabaseTarget()) missing.push('E2E_SUPABASE_URL + E2E_SUPABASE_ANON_KEY')
  if (missing.length === 0) return null
  return (
    `Authenticated journeys need a real Supabase session. Missing: ${missing.join(', ')}. ` +
    'See e2e/README.md — the app has no password sign-in form, so the session is minted ' +
    'against the Supabase token endpoint and injected as cookies.'
  )
}

/**
 * Why the database-backed seed helpers cannot run, or null when they can.
 *
 * Separate from {@link authSkipReason} on purpose: a run against a shared
 * deployment can drive every UI journey with only a login, and should not be
 * forced to also hold database credentials. Only the specs that must ARRANGE
 * server-side state (the daily run cap) need this, and only those skip.
 */
export function seedSkipReason(): string | null {
  if (!trimmed('E2E_DATABASE_URL')) {
    return (
      'Seed-backed specs need E2E_DATABASE_URL (a direct Postgres URL for the ' +
      'environment under test) so workspace state can be arranged and reset.'
    )
  }
  return null
}

/** The base URL under test, matching playwright.config.ts. */
export function baseUrl(): string {
  return trimmed('E2E_BASE_URL') ?? 'http://127.0.0.1:3000'
}

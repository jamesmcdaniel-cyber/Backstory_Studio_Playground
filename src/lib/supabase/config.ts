export function getSupabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !anonKey) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required')
  }

  return { url, anonKey }
}

/**
 * Cookie options for the Supabase session, applied at EVERY `createServerClient`
 * call site. Without this the library's defaults apply, which omit `secure`
 * entirely — leaving the access AND refresh tokens on a cookie a downgraded or
 * intercepted http request would send in clear.
 *
 * `httpOnly` is deliberately absent: the browser client reads the session via
 * `document.cookie` (createBrowserClient), so forcing it here would sign
 * everyone out. Script access is therefore contained by CSP, not by the cookie
 * flag — specifically by the nonce-based `script-src 'strict-dynamic'` built in
 * src/lib/security/csp.ts and attached per-request in src/middleware.ts.
 *
 * That dependency is real, not decorative: this cookie holds the access AND
 * refresh token in a place any executing script can read, so the CSP is the only
 * thing standing between an XSS and a full session takeover. Weakening
 * script-src (adding 'unsafe-inline', a wildcard host, or a static duplicate
 * policy) re-opens that path. Do not do it without making the cookie httpOnly
 * first, which means moving session reads server-side.
 *
 * Applied at EVERY client, browser and server — see ./client.ts.
 *
 * `secure` is conditional so local http development still holds a session;
 * every deployed environment runs https and gets the flag.
 */
export const SUPABASE_COOKIE_OPTIONS = {
  secure: process.env.NODE_ENV === 'production',
  // None in production so the session travels inside a third-party iframe —
  // the Salesforce embed is permanently signed out under Lax, which never
  // sends a cookie in a framed context. None requires Secure, so development
  // (plain http) stays on Lax. The CSRF exposure None reopens is closed by
  // the origin check in src/middleware.ts (src/lib/security/cross-origin-guard).
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
} as const

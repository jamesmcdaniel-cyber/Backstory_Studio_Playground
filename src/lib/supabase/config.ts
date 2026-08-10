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
 * flag — see next.config.js.
 *
 * `secure` is conditional so local http development still holds a session;
 * every deployed environment runs https and gets the flag.
 */
export const SUPABASE_COOKIE_OPTIONS = {
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
} as const

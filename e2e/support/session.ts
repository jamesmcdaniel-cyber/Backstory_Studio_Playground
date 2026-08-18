/**
 * Minting a real Supabase session for the browser suite.
 *
 * ── Why this is not "fill in the login form" ──────────────────────────────
 * There IS no login form to fill. `/auth/login` renders AuthGateway
 * (src/components/auth/auth-gateway.tsx), which offers exactly two doors:
 * "Continue with Google" (an OAuth redirect to Google) and a domain-first
 * enterprise SSO field (a SAML redirect to the customer's IdP). Both hand the
 * browser to a third party we do not control and must not automate — driving a
 * real Google consent screen from CI is both against Google's terms and the
 * single flakiest thing a suite can contain.
 *
 * `supabase.auth.signInWithPassword` is wired up in the Supabase provider but
 * no component calls it, so password auth exists as a capability of the
 * Supabase project, not as a surface of this app.
 *
 * So the session is minted where the browser would have minted it anyway —
 * Supabase's own token endpoint — and then written into the browser as the
 * cookies @supabase/ssr would have written. That is legitimate rather than a
 * cheat: this app's session IS that cookie. src/lib/supabase/middleware.ts
 * reads it with createServerClient and calls `supabase.auth.getUser()`, a real
 * network verification against Supabase Auth. A forged or expired token fails
 * there exactly as it would for a real user, so every assertion downstream is
 * made against genuinely authenticated traffic.
 *
 * ── The one thing this cannot cover ───────────────────────────────────────
 * The IdP redirect itself. Whether Google/SAML correctly lands on
 * /auth/callback is NOT exercised here and remains untested by any automated
 * suite. Recorded in e2e/README.md so it is a known gap rather than a
 * forgotten one.
 */
import type { BrowserContext, Cookie } from '@playwright/test'

/** Mirrors MAX_CHUNK_SIZE in @supabase/ssr/dist/main/utils/chunker.js. */
const MAX_CHUNK_SIZE = 3180
/** Mirrors BASE64_PREFIX in @supabase/ssr/dist/main/utils/cookies.js. */
const BASE64_PREFIX = 'base64-'

export interface SupabaseSession {
  access_token: string
  refresh_token: string
  expires_at?: number
  expires_in?: number
  token_type?: string
  user?: { id?: string; email?: string }
}

/**
 * The cookie name @supabase/ssr defaults to: `sb-<project-ref>-auth-token`.
 *
 * The ref is the first label of the Supabase hostname. No `cookieOptions.name`
 * is configured anywhere in src/, and createBrowserClient only overrides the
 * storage key when one is — so the default is what the app actually reads.
 */
export function sessionCookieName(supabaseUrl: string): string {
  const host = new URL(supabaseUrl).hostname
  return `sb-${host.split('.')[0]}-auth-token`
}

/**
 * Split a value the way @supabase/ssr's createChunks does.
 *
 * Chunking is measured on the URI-ENCODED length, not the raw length, because
 * that is what actually travels in a Set-Cookie header — and the encoded form
 * of a base64url payload is identical to the raw form (its alphabet contains no
 * characters encodeURIComponent escapes). That equality is what makes this
 * simplified split faithful: with no escape sequences there are no partial
 * escapes or unicode boundaries to preserve, which is all the library's extra
 * machinery exists to handle. The `base64-` prefix is likewise escape-free.
 */
export function chunkCookieValue(name: string, value: string): { name: string; value: string }[] {
  if (encodeURIComponent(value).length <= MAX_CHUNK_SIZE) return [{ name, value }]
  const chunks: { name: string; value: string }[] = []
  for (let index = 0; index * MAX_CHUNK_SIZE < value.length; index += 1) {
    chunks.push({
      name: `${name}.${index}`,
      value: value.slice(index * MAX_CHUNK_SIZE, (index + 1) * MAX_CHUNK_SIZE),
    })
  }
  return chunks
}

/** Encode a session the way the ssr client's storage adapter does. */
export function encodeSessionCookie(session: SupabaseSession): string {
  return BASE64_PREFIX + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url')
}

/**
 * Exchange email + password for a session at Supabase's token endpoint.
 *
 * Throws with the provider's own message rather than a generic one: "Invalid
 * login credentials" and "captcha protection: request disallowed" need
 * completely different fixes, and collapsing them into "sign-in failed" costs
 * whoever is on call the only clue they had.
 */
export async function mintSession(args: {
  supabaseUrl: string
  anonKey: string
  email: string
  password: string
  /** Only needed when the Supabase project has Turnstile CAPTCHA enabled. */
  captchaToken?: string
}): Promise<SupabaseSession> {
  const endpoint = `${args.supabaseUrl.replace(/\/$/, '')}/auth/v1/token?grant_type=password`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { apikey: args.anonKey, Authorization: `Bearer ${args.anonKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      email: args.email,
      password: args.password,
      ...(args.captchaToken ? { gotrue_meta_security: { captcha_token: args.captchaToken } } : {}),
    }),
  })
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    const detail =
      (typeof body.error_description === 'string' && body.error_description) ||
      (typeof body.msg === 'string' && body.msg) ||
      (typeof body.message === 'string' && body.message) ||
      JSON.stringify(body)
    throw new Error(
      `Supabase password grant failed (${response.status}): ${detail}\n` +
        'If this says the request was disallowed, the project has CAPTCHA protection on. ' +
        'Either use a Turnstile testing key on the E2E project or pass E2E_CAPTCHA_TOKEN.',
    )
  }
  if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') {
    throw new Error(`Supabase returned no tokens: ${JSON.stringify(body)}`)
  }
  return body as unknown as SupabaseSession
}

/** Build the cookies for a session, ready for `context.addCookies`. */
export function sessionCookies(args: {
  session: SupabaseSession
  supabaseUrl: string
  baseUrl: string
}): Cookie[] {
  const { hostname, protocol } = new URL(args.baseUrl)
  const name = sessionCookieName(args.supabaseUrl)
  return chunkCookieValue(name, encodeSessionCookie(args.session)).map((chunk) => ({
    name: chunk.name,
    value: chunk.value,
    domain: hostname,
    path: '/',
    expires: -1,
    // Deliberately false, matching SUPABASE_COOKIE_OPTIONS: the browser client
    // reads this cookie via document.cookie, so httpOnly would sign everyone
    // out. See the long comment in src/lib/supabase/config.ts.
    httpOnly: false,
    // `secure` tracks the scheme under test, exactly as the app's own cookie
    // options track NODE_ENV. A secure cookie on an http origin is silently
    // dropped, which would present as "signed in but every page redirects".
    secure: protocol === 'https:',
    sameSite: 'Lax' as const,
  }))
}

export async function applySession(
  context: BrowserContext,
  args: { session: SupabaseSession; supabaseUrl: string; baseUrl: string },
): Promise<void> {
  await context.addCookies(sessionCookies(args))
}

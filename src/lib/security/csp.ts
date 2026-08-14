import { TURNSTILE_ORIGIN } from '@/lib/auth/captcha'

/**
 * Content-Security-Policy for the parent application document.
 *
 * ── Why a strict script-src is load-bearing here, not defence in depth ────
 * The Supabase session cookie deliberately omits `httpOnly` — the browser client
 * reads it via document.cookie (createBrowserClient), so setting the flag would
 * sign everyone out. src/lib/supabase/config.ts says script access is "contained
 * by CSP, not by the cookie flag", and until now that was not true: the policy
 * shipped `frame-ancestors`, `base-uri` and `object-src` and left script-src
 * unset. Any XSS anywhere in the app could read the access AND refresh token.
 *
 * This is the control that comment promised. `'strict-dynamic'` with a
 * per-request nonce means only Next's nonced bootstrap script runs, plus
 * whatever it loads — an injected <script> tag has no nonce and is refused.
 *
 * ── Rollout ──────────────────────────────────────────────────────────────
 * A strict CSP breaks the app loudly if any origin is missed, so it ships behind
 * CSP_REPORT_ONLY. Set CSP_REPORT_ONLY=true to emit
 * Content-Security-Policy-Report-Only: the browser reports what WOULD have been
 * blocked and blocks nothing. Watch the console/report endpoint for a full
 * release cycle, then unset it to enforce.
 */

/**
 * Origins the application document legitimately reaches.
 *
 * Supabase's URL is per-project (and per-environment), so it is derived from the
 * configured value rather than wildcarded — a `*.supabase.co` entry would admit
 * every Supabase project on the internet as a script and connection source.
 */
function supabaseOrigins(): { http: string; ws: string } | null {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    return { http: url.origin, ws: `${url.protocol === 'http:' ? 'ws' : 'wss'}://${url.host}` }
  } catch {
    return null
  }
}

/** Icon CDN used by the integrations catalogue for provider logos. */
const ICON_CDN = 'https://cdn.simpleicons.org'

export interface CspOptions {
  nonce: string
  /** Development needs 'unsafe-eval' for React Refresh / HMR. */
  isDevelopment?: boolean
}

export function buildContentSecurityPolicy({ nonce, isDevelopment = false }: CspOptions): string {
  const supabase = supabaseOrigins()

  const scriptSrc = [
    `'nonce-${nonce}'`,
    // Trust propagates from the nonced bootstrap to the chunks it loads, which
    // is what makes a nonce workable with Next's dynamic imports at all.
    "'strict-dynamic'",
    // Ignored by browsers that honour 'strict-dynamic'; kept so browsers that
    // do not (older Safari) still get a same-origin restriction rather than
    // falling all the way back to default-src.
    "'self'",
    'https:',
    // React Refresh compiles components with eval in dev. Never in production.
    ...(isDevelopment ? ["'unsafe-eval'"] : []),
  ]

  const connectSrc = [
    "'self'",
    ...(supabase ? [supabase.http, supabase.ws] : []),
    // Sentry and the Turnstile challenge both post from the page.
    ...(process.env.NEXT_PUBLIC_SENTRY_DSN ? [sentryOrigin()].filter(Boolean) as string[] : []),
    TURNSTILE_ORIGIN,
    ...(isDevelopment ? ['ws://127.0.0.1:*', 'ws://localhost:*'] : []),
  ]

  return [
    // Everything not named below falls back to same-origin only.
    "default-src 'self'",
    `script-src ${scriptSrc.join(' ')}`,
    // Tailwind ships as a stylesheet, but @xyflow/react, CodeMirror and the
    // motion primitives all set element styles at runtime, which a strict
    // style-src would break. Inline STYLE cannot read cookies or exfiltrate a
    // session the way inline SCRIPT can, so this is a deliberate, bounded
    // exception rather than a hole of the same class.
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${ICON_CDN}`,
    "font-src 'self' data:",
    `connect-src ${connectSrc.join(' ')}`,
    // Agent HTML previews render in a sandboxed iframe from srcDoc, which is an
    // opaque origin; Turnstile renders its challenge in an iframe.
    `frame-src 'self' blob: ${TURNSTILE_ORIGIN}`,
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    // Anti-clickjacking and injection-hardening, carried over unchanged.
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    // Both spellings on purpose. `report-uri` is deprecated but is what Safari
    // and older Chrome/Firefox actually send; `report-to` is the modern one and
    // needs the Reporting-Endpoints response header (set in src/middleware.ts).
    // Sending only the modern directive would collect nothing from a large share
    // of real browsers — precisely the ones whose violations we most need.
    `report-uri ${CSP_REPORT_PATH}`,
    `report-to ${CSP_REPORT_GROUP}`,
  ].join('; ')
}

/** Where violation reports are collected. See src/app/api/csp-report/route.ts. */
export const CSP_REPORT_PATH = '/api/csp-report'
/** Reporting API group name, shared by `report-to` and Reporting-Endpoints. */
export const CSP_REPORT_GROUP = 'csp'

/** Value for the `Reporting-Endpoints` header that `report-to` resolves against. */
export function reportingEndpointsHeader(): string {
  return `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`
}

/** The Sentry ingest origin derived from the DSN, or null when unparseable. */
function sentryOrigin(): string | null {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim()
  if (!dsn) return null
  try {
    return new URL(dsn).origin
  } catch {
    return null
  }
}

/**
 * Which header to send. Report-only during rollout means a missed origin shows
 * up as a report instead of a blank page.
 */
export function cspHeaderName(): 'Content-Security-Policy' | 'Content-Security-Policy-Report-Only' {
  return process.env.CSP_REPORT_ONLY === 'true'
    ? 'Content-Security-Policy-Report-Only'
    : 'Content-Security-Policy'
}

/** A fresh 128-bit nonce, base64. Must be per-response — a reused nonce is no nonce. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
}

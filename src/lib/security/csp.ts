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

/**
 * Hosts the integrations catalogue pulls provider logos from (see
 * components/integrations/brand-logo-sources): Simple Icons for developer
 * brands, DuckDuckGo's favicon service for everyone else (Gong, Clari,
 * BambooHR…), and Nango's own CDN for the logo the catalogue hands us.
 */
const ICON_CDNS = [
  'https://cdn.simpleicons.org',
  'https://icons.duckduckgo.com',
  'https://app.nango.dev',
]

/**
 * Where the Nango Connect UI is embedded from.
 *
 * openConnectUI renders the OAuth connect flow in an IFRAME from this origin —
 * the CSP rollout omitted it from frame-src, which blocked every Nango
 * integration with a full-page "This content is blocked". Derived from the
 * same NEXT_PUBLIC_NANGO_CONNECT_URL override use-nango-connect.ts passes as
 * baseURL, so a self-hosted Connect UI is allowed without a code change and
 * the CSP cannot drift from what the client actually embeds.
 */
function nangoConnectOrigin(): string {
  const raw = process.env.NEXT_PUBLIC_NANGO_CONNECT_URL?.trim()
  if (raw) {
    try {
      return new URL(raw).origin
    } catch {
      /* fall through to the hosted default */
    }
  }
  return 'https://connect.nango.dev'
}

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

  /**
   * Who may put this app in an iframe. Ships locked ('none'); an operator
   * opts in per deployment with EMBED_FRAME_ANCESTORS — a space-separated
   * list of https origins, e.g. "https://*.lightning.force.com" for a
   * Salesforce Lightning embed.
   *
   * The value feeds a security header, so it is sanitized, not trusted:
   * only https origin tokens survive (no schemes that execute, no CSP
   * keywords, and a `;` can never travel through to smuggle a directive).
   * A value that sanitizes down to nothing falls back to 'none' — a typo
   * must fail closed, not open. `'self'` rides along whenever embedding is
   * on so same-origin previews keep working.
   *
   * Deliberately NOT defaulted to Salesforce's wildcards in code: which
   * organisations may frame a workspace is an operator decision, and
   * `*.force.com` in particular includes anonymous Experience Cloud sites —
   * an allow-list someone chose is the whole safety argument.
   */
  const embedAncestors = (process.env.EMBED_FRAME_ANCESTORS ?? '')
    .split(/\s+/)
    .filter((token) => /^https:\/\/[a-z0-9*][a-z0-9*.:-]*$/i.test(token))
  const frameAncestors = embedAncestors.length ? `'self' ${embedAncestors.join(' ')}` : "'none'"

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
    // lh3.googleusercontent.com serves the Google profile avatar every
    // Google-auth user renders in the shell — the rollout missed it and every
    // avatar was silently blocked. Deliberately NOT `https:`: agent-authored
    // markdown/report content can carry <img> tags, and a blanket https:
    // img-src would let injected content exfiltrate data through image URL
    // query strings — the classic markdown-image leak. Named hosts only.
    `img-src 'self' data: blob: ${ICON_CDNS.join(' ')} https://lh3.googleusercontent.com`,
    "font-src 'self' data:",
    `connect-src ${connectSrc.join(' ')}`,
    // Agent HTML previews render in a sandboxed iframe from srcDoc, which is an
    // opaque origin; Turnstile renders its challenge in an iframe; the Nango
    // Connect UI (every OAuth integration connect) is an iframe too.
    `frame-src 'self' blob: ${TURNSTILE_ORIGIN} ${nangoConnectOrigin()}`,
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    // Anti-clickjacking and injection-hardening. 'none' unless an operator
    // configured an embed allow-list above.
    `frame-ancestors ${frameAncestors}`,
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
  return cspReportOnly() ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy'
}

/**
 * Whether the policy ships as report-only.
 *
 * Tolerant parse, because the strict `=== 'true'` comparison silently ENFORCED
 * with the flag set in Vercel: a value that arrives as "true\n" or "TRUE" (the
 * CLI empty-value/whitespace gotcha this project has hit before) failed the
 * comparison, and the safety flag inverted into its opposite — the exact
 * blank-page rollout it exists to prevent, discovered when every Nango connect
 * died in production. Trimmed, case-insensitive, and accepting the spellings
 * people actually type. Unset or unrecognized still enforces: report-only is
 * the temporary state, and a typo must not quietly disable the CSP forever.
 */
export function cspReportOnly(): boolean {
  const raw = process.env.CSP_REPORT_ONLY?.trim().toLowerCase()
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on'
}

/** A fresh 128-bit nonce, base64. Must be per-response — a reused nonce is no nonce. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
}

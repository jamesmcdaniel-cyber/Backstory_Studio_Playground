/**
 * Cloudflare Turnstile — bot protection for the authentication surface.
 *
 * ── Why this has to be Supabase-side, not app-side ────────────────────────
 * Password sign-in, sign-up and password reset all run browser → Supabase
 * directly (`supabase.auth.*` in src/components/providers/supabase-provider.tsx).
 * Those requests never touch a Next.js route, so `withAuthenticatedApi`'s rate
 * limiter cannot see them and no check this app performs is on the path. An
 * app-side "are you a bot" gate in front of the form would be decoration: an
 * attacker calls Supabase's token endpoint with the published anon key and skips
 * it entirely.
 *
 * Turnstile is effective precisely because SUPABASE verifies it. With CAPTCHA
 * protection enabled on the Supabase project, Supabase Auth rejects any
 * sign-in / sign-up / recovery request whose `options.captchaToken` is missing
 * or invalid — including one crafted straight against its endpoint. This module
 * supplies that token; Supabase enforces it.
 *
 * ── Configuration (both halves are required) ──────────────────────────────
 *   1. Supabase dashboard → Authentication → Attack Protection → enable CAPTCHA,
 *      provider "Turnstile", and paste the Turnstile SECRET key.
 *   2. Set NEXT_PUBLIC_TURNSTILE_SITE_KEY here to the matching SITE key.
 *
 * Enabling only (1) locks everyone out of password sign-in — the client would
 * send no token. Enabling only (2) renders a widget that protects nothing.
 * `assertCaptchaConfigured` exists so that mismatch is caught at boot rather
 * than by a user who cannot sign in.
 *
 * Google and SSO sign-in deliberately take no token: those flows redirect to the
 * identity provider, which runs its own abuse controls, and Supabase does not
 * accept a captcha token for them.
 */

/** The Turnstile site key, or null when bot protection is not configured. */
export function turnstileSiteKey(): string | null {
  const key = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim()
  return key || null
}

/** Whether the auth forms should render a Turnstile widget. */
export function captchaEnabled(): boolean {
  return turnstileSiteKey() !== null
}

/**
 * The origin the Turnstile script and its iframe are loaded from. Exported so
 * the Content-Security-Policy allow-lists exactly this host and nothing wider —
 * see src/lib/security/csp.ts.
 */
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com'

/**
 * Fail closed in production when password auth is reachable without bot
 * protection. Called from the server env assertion at boot.
 *
 * Not an error when password auth is off (AUTH_ALLOW_PASSWORD unset in
 * production, the normal SSO/invite-only posture): there is no password form to
 * protect, and demanding a Turnstile key would block a correct deployment.
 */
export function assertCaptchaConfigured(env: NodeJS.ProcessEnv = process.env): string[] {
  const warnings: string[] = []
  if (env.NODE_ENV !== 'production') return warnings
  if (env.AUTH_ALLOW_PASSWORD !== 'true') return warnings
  if (!env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim()) {
    warnings.push(
      'AUTH_ALLOW_PASSWORD=true without NEXT_PUBLIC_TURNSTILE_SITE_KEY — the password ' +
        'sign-in form has no bot protection and app-side rate limiting cannot reach it.',
    )
  }
  return warnings
}

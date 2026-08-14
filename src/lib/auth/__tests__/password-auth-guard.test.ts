import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TURNSTILE_ORIGIN } from '../captcha'

/**
 * Password authentication may not be reintroduced without bot protection.
 *
 * The product signs people in with Google OAuth and SSO only — `signIn`,
 * `signUp` and `resetPassword` exist on the Supabase provider context but have
 * no caller anywhere in the UI. That is what makes the credential-stuffing
 * surface small today, and it is an accident of the current UI rather than a
 * decision anything enforces.
 *
 * It matters because of where password auth runs. `supabase.auth.signInWithPassword`
 * goes browser → Supabase directly, never through a Next.js route, so
 * withAuthenticatedApi's rate limiter cannot see it and NOTHING this app does
 * can throttle it. Someone adding a password form would therefore be adding an
 * unthrottleable brute-force target, and would get no warning from any existing
 * test.
 *
 * This test is that warning. If a password-auth call site appears, the form it
 * belongs to must carry a Turnstile token (useTurnstile in
 * src/components/auth/turnstile.tsx) and the Supabase project must have CAPTCHA
 * protection enabled — Supabase is the only party on that request path able to
 * enforce it. See src/lib/auth/captcha.ts.
 */

const SRC = fileURLToPath(new URL('../../..', import.meta.url))

/** The provider methods that reach Supabase's password endpoints. */
const PASSWORD_AUTH_CALLS = /\b(signIn|signUp|resetPassword)\s*\(/

/**
 * Files allowed to name these methods: the provider that defines them, and this
 * test. Everything else is a call site.
 */
const ALLOWED = new Set([
  path.join(SRC, 'components/providers/supabase-provider.tsx'),
])

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry.name) && statSync(full).isFile()) out.push(full)
  }
  return out
}

test('password auth has no call site, or the one it has carries a captcha token', () => {
  const offenders: string[] = []

  for (const file of sourceFiles(SRC)) {
    if (ALLOWED.has(file)) continue
    const source = readFileSync(file, 'utf8')
    if (!PASSWORD_AUTH_CALLS.test(source)) continue
    // A call site is acceptable only if the same file wires bot protection.
    if (source.includes('useTurnstile')) continue
    offenders.push(path.relative(SRC, file))
  }

  assert.deepEqual(
    offenders,
    [],
    'Password auth call site(s) without bot protection: ' +
      `${offenders.join(', ')}.\n` +
      'supabase.auth.signInWithPassword bypasses this app entirely, so no server-side ' +
      'rate limit can reach it. Wire useTurnstile() into the form and pass its token, ' +
      'and enable CAPTCHA protection on the Supabase project (see src/lib/auth/captcha.ts).',
  )
})

test('the captcha origin is a single pinned host', () => {
  // The CSP allow-lists this exact value; a wildcard here would widen script-src.
  assert.equal(TURNSTILE_ORIGIN, 'https://challenges.cloudflare.com')
  assert.ok(!TURNSTILE_ORIGIN.includes('*'))
})

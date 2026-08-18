/**
 * The authenticated project's dependency: mints one session, proves it is
 * genuinely authenticated, and saves it as storage state for every journey.
 *
 * Runs as a TEST rather than as a `globalSetup` function so that it appears in
 * the report with a name and a status. A globalSetup that skipped would be
 * invisible; this one shows up as a skipped test with the reason attached,
 * which is the whole point — a suite that stops testing must SAY so.
 *
 * When it cannot sign in it still writes an EMPTY storage state, so the
 * dependent projects load cleanly and each of their specs reports its own loud
 * skip. Failing to write the file would instead error the whole project out
 * with a file-not-found, which reads like infrastructure breakage rather than
 * like missing configuration.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { expect, test as setup } from '@playwright/test'
import { AUTH_MARKER, STORAGE_STATE, authSkipReason, baseUrl, supabaseTarget, testUserCredentials } from './support/env'
import { applySession, mintSession } from './support/session'

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

/** An empty state is a valid state — it just carries no session. */
function writeEmptyState(reason: string): void {
  if (!existsSync(STORAGE_STATE)) write(STORAGE_STATE, JSON.stringify({ cookies: [], origins: [] }))
  write(AUTH_MARKER, JSON.stringify({ authenticated: false, reason }, null, 2))
}

setup('authenticate the end-to-end test user', async ({ context, request }) => {
  const reason = authSkipReason()
  if (reason) writeEmptyState(reason)
  setup.skip(Boolean(reason), reason ?? '')

  const target = supabaseTarget()!
  const credentials = testUserCredentials()!

  const session = await mintSession({
    supabaseUrl: target.url,
    anonKey: target.anonKey,
    email: credentials.email,
    password: credentials.password,
    captchaToken: process.env.E2E_CAPTCHA_TOKEN?.trim() || undefined,
  })

  await applySession(context, { session, supabaseUrl: target.url, baseUrl: baseUrl() })

  // The session is not proven by the cookie existing — it is proven by the
  // server accepting it. /api/auth/context runs the full resolution chain
  // (Supabase getUser → Prisma user → organization → permissions) with only
  // the MFA and SSO gates skipped, so a 200 here means every other authenticated
  // route will resolve an org for this identity too.
  const probe = await context.request.get(`${baseUrl()}/api/auth/context`)
  const body = await probe.text()
  expect(
    probe.status(),
    `The minted session was refused by /api/auth/context (${probe.status()}): ${body}\n` +
      'Common causes: the user\'s email is not admitted by isAllowedEmail (company domain, ' +
      'ALLOWED_EMAIL_DOMAINS, a PlatformAllowedDomain row, or a live PENDING invitation); ' +
      'the account is deactivated; or ENTITLEMENT_GATE / BACKSTORY_MCP_GATE are on for this deploy.',
  ).toBe(200)

  const context_ = JSON.parse(body).context as { organizationId: string; userId: string; permissions: string[] }
  expect(context_.organizationId, 'the test user resolved no workspace').toBeTruthy()

  // Recorded for the specs: whether this identity is exempt from the free-tier
  // ceilings. The daily-run-cap journey asserts a REFUSAL, which an exempt
  // account can never produce — better to say so than to fail mysteriously.
  const canReview = context_.permissions.includes('catalogue.review')

  await context.storageState({ path: STORAGE_STATE })
  write(
    AUTH_MARKER,
    JSON.stringify(
      { authenticated: true, userId: context_.userId, organizationId: context_.organizationId, canReview },
      null,
      2,
    ),
  )

  // `request` is unused for assertions but keeps the fixture list honest about
  // what this setup touches.
  void request
})

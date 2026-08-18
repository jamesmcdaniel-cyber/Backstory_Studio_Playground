/**
 * Journey: a signed-in person lands in the application.
 *
 * ── What is real here and what is not ─────────────────────────────────────
 * The SESSION is real: it was minted at Supabase's token endpoint and is
 * verified on every navigation by `supabase.auth.getUser()` inside
 * src/lib/supabase/middleware.ts. Every assertion below is therefore made
 * against genuinely authenticated traffic.
 *
 * The IDENTITY-PROVIDER REDIRECT is not covered, and cannot be: /auth/login
 * offers only "Continue with Google" and enterprise SAML, both of which hand
 * the browser to a third party. Driving a real Google consent screen from CI
 * is the flakiest possible dependency and is against Google's automation
 * terms. So the leg from "click Continue with Google" to "/auth/callback sets
 * a session" remains untested by any automated suite — see e2e/README.md.
 * What IS covered is everything that leg produces: a session cookie that the
 * middleware accepts and that resolves a workspace.
 */
import { expect, test } from '../support/fixtures'

test('an authenticated session opens the application instead of the sign-in gateway', async ({ page }) => {
  await page.goto('/flows')

  // The negative half matters as much as the positive: an unauthenticated
  // browser is redirected to /auth/login by the middleware, so staying on
  // /flows is itself the proof the session was accepted.
  await expect(page).toHaveURL(/\/flows$/)
  // ...and an authenticated CHROME, not merely a rendered shell. "New flow"
  // is an authenticated affordance: it exists only once the page knows who
  // this is and what workspace they are in.
  await expect(page.getByRole('button', { name: 'New flow' })).toBeVisible()
})

test('a signed-in person on the sign-in page is carried on to the application', async ({ page }) => {
  // The middleware's signed-in branch. Worth its own assertion because the
  // failure mode is a loop: a user with a valid session bouncing between
  // /auth/login and the app is indistinguishable from being signed out.
  await page.goto('/auth/login')
  await expect(page).toHaveURL(/\/dashboard/)
})

test('the session resolves a workspace, permissions, and an identity', async ({ page, workspace }) => {
  // The chain behind every authenticated page: Supabase user → Prisma user →
  // organization → permissions. A session that authenticates but resolves no
  // organization renders a shell where every data call 403s, which looks like
  // an empty account rather than like a broken one.
  const response = await page.request.get('/api/auth/context')
  expect(response.status()).toBe(200)

  const { context } = await response.json()
  expect(context.organizationId).toBe(workspace.organizationId)
  expect(context.userId).toBe(workspace.userId)
  expect(context.permissions.length, 'the session resolved no permissions at all').toBeGreaterThan(0)
})

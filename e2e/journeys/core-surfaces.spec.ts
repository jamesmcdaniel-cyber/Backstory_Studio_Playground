/**
 * Journey: the signed-in shell and the read-mostly surfaces load — the
 * sidebar, Artifacts, and Settings.
 *
 * Nothing is stubbed and nothing is created, so these hold on an empty
 * workspace and on a busy one alike: every assertion is either structural
 * (the page and its controls are there) or compared against what the server
 * says this session may do.
 *
 * ── Why the sidebar is asserted against permissions, not constants ────────
 * Admin and Reviews are permission-gated nav, and the shell now resolves the
 * caller's permissions on the SERVER so those entries are right on the first
 * paint rather than a round trip later. The regression a constant cannot
 * catch is a gated entry drawn for someone who lacks the permission — so the
 * expectation is derived from /api/auth/context, and the end-to-end account
 * (a workspace admin, never platform staff) therefore asserts Admin ABSENT.
 */
import { expect, test } from '../support/fixtures'
import { sessionPermissions } from '../support/api'

const PRIMARY_NAV = ['Home', 'Agents', 'Flows', 'Artifacts', 'Library', 'Integrations']

/** The server-rendered <nav aria-label="Main navigation"> — what the first paint shows. */
function serverRenderedNav(html: string): string {
  const match = html.match(/<nav[^>]*aria-label="Main navigation"[^>]*>([\s\S]*?)<\/nav>/)
  expect(match, 'the server-rendered page carried no main navigation at all').not.toBeNull()
  return match![1]
}

test('the sidebar draws its permission-gated nav on the first paint, and no Admin for a workspace admin', async ({ page }) => {
  const permissions = await sessionPermissions(page.request)
  const adminExpected = permissions.has('platform.administer')
  const reviewsExpected = permissions.has('catalogue.review')

  // First paint: the HTML as the server sent it, before any client JS runs.
  const response = await page.request.get('/dashboard')
  expect(response.status()).toBe(200)
  const nav = serverRenderedNav(await response.text())
  for (const href of ['/dashboard', '/agents', '/flows', '/artifacts', '/templates', '/integrations']) {
    expect(nav, `the first paint is missing the ${href} link`).toContain(`href="${href}"`)
  }
  expect(nav.includes('href="/admin/users"'), 'Admin on the first paint must match platform.administer').toBe(adminExpected)
  expect(nav.includes('href="/admin/catalogue"'), 'Reviews on the first paint must match catalogue.review').toBe(reviewsExpected)

  // After hydration the same, and it stays that way once the page settles —
  // a client-side re-resolution must not add an entry the server withheld.
  await page.goto('/dashboard')
  const sidebar = page.getByRole('navigation', { name: 'Main navigation' })
  for (const name of PRIMARY_NAV) await expect(sidebar.getByRole('link', { name, exact: true })).toBeVisible()
  await page.waitForLoadState('networkidle')
  await expect(sidebar.getByRole('link', { name: 'Admin', exact: true })).toHaveCount(adminExpected ? 1 : 0)
  await expect(sidebar.getByRole('link', { name: 'Reviews', exact: true })).toHaveCount(reviewsExpected ? 1 : 0)
  expect(adminExpected, 'The end-to-end account holds platform.administer — it must be an ordinary workspace admin (see docs/e2e-authenticated-setup.md).').toBe(false)
})

test('the artifacts list loads, whether or not this workspace has produced any', async ({ page }) => {
  // The list the page renders comes from this route; a failure here renders as
  // an empty state, so it is asserted directly rather than inferred from one.
  const listed = await page.request.get('/api/artifacts')
  expect(listed.status(), `GET /api/artifacts failed: ${await listed.text()}`).toBe(200)

  await page.goto('/artifacts')
  await expect(page.getByRole('heading', { name: 'What your agents have produced' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Artifacts', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('Loading…')).toHaveCount(0)
  // Either outcome is a loaded page; what is not is a spinner or an error.
  await expect(page.getByText('No artifacts yet').or(page.locator('a[href^="/artifacts/"]').first())).toBeVisible()
})

test('settings loads the signed-in account and its workspace', async ({ page }) => {
  const permissions = await sessionPermissions(page.request)

  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
  const sections = page.getByRole('navigation', { name: 'Settings sections' })
  for (const name of ['Account', 'Workspace', 'Members']) await expect(sections.getByRole('button', { name, exact: true })).toBeVisible()
  await expect(sections.getByRole('button', { name: 'Platform', exact: true })).toHaveCount(permissions.has('platform.administer') ? 1 : 0)

  // The Account section is about THIS person — its email field is the session's identity.
  await expect(page.locator('#email')).toHaveValue(process.env.E2E_USER_EMAIL!.trim().toLowerCase())

  // And the workspace section opens on the workspace the session resolved.
  await sections.getByRole('button', { name: 'Workspace', exact: true }).click()
  await expect(page).toHaveURL(/\/settings\?tab=workspace$/)
  await expect(page.getByText('Your team’s shared workspace.')).toBeVisible()
})

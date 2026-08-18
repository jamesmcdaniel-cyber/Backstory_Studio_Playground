/**
 * Journey: connect a credential.
 *
 * ── Two planes, and why both are here ────────────────────────────────────
 * The product has an OAuth plane (Nango) and a non-OAuth plane (HTTP
 * credentials). Only the second can be driven end to end without a third
 * party, so it carries the real assertions; the first is asserted up to our
 * side of the boundary and no further.
 *
 * ── STUBBED BOUNDARY 1: POST /api/http-credentials ───────────────────────
 * That route performs a REAL outbound request from the server
 * (`verifyCredentialLive`) against the endpoint the user typed, behind an
 * SSRF check that requires a public host. A journey test must not depend on
 * some third-party API being reachable and returning 200, so the route is
 * stubbed at the browser boundary. What is asserted is everything on OUR side:
 * that the dialog collects the right fields, sends the right authType, url and
 * secret config, and reports the outcome the user needs — including the
 * rejection branch, which is the one people actually hit.
 *
 * ── STUBBED BOUNDARY 2: POST /api/nango/session-token ────────────────────
 * Connecting an app account calls `nango.openConnectUI()`, which mounts an
 * iframe pointed at connect.nango.dev and hands the user to the provider's own
 * consent screen. There is nothing on our side of that iframe to assert and
 * nothing legitimate to automate inside it. So the session-token call — the
 * last request that is ours — is intercepted, and the spec asserts that we ask
 * for a token for the right integration and that we tell the user when we
 * cannot get one. The popup itself, and everything past it, is uncovered.
 */
import { expect, test } from '../support/fixtures'

test.describe('HTTP credentials', () => {
  test('creating an HTTP credential collects the secret and reports it verified', async ({ page }) => {
    let submitted: Record<string, unknown> | null = null
    await page.route('**/api/http-credentials', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      submitted = route.request().postDataJSON()
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, credential: { id: 'e2e-cred', name: 'E2E credential', authType: 'basic' } }),
      })
    })

    await page.goto('/credentials')
    const create = page.getByRole('button', { name: 'New credential' })
    await expect(
      create,
      'no "New credential" button — the test user lacks integration.manage, so this journey cannot be driven',
    ).toBeVisible({ timeout: 30_000 })
    await create.click()

    await expect(page.getByText('Set up HTTP credential')).toBeVisible()
    await page.locator('#credential-url').fill('https://api.example.com/v1/me')
    await page.locator('#credential-name').fill('E2E credential')
    await page.locator('#credential-username').fill('e2e-user')
    await page.locator('#credential-password').fill('e2e-secret')

    await page.getByRole('button', { name: 'Verify & save' }).click()

    await expect(page.getByText('Credential verified and saved.')).toBeVisible({ timeout: 30_000 })

    // Our side of the flow, asserted on the wire: the dialog must send the
    // secret it collected, bound to the host it was verified against. A dialog
    // that renders correctly but posts an empty config would look identical
    // on screen.
    expect(submitted, 'the dialog never posted a credential').not.toBeNull()
    expect(submitted!.name).toBe('E2E credential')
    expect(submitted!.url).toBe('https://api.example.com/v1/me')
    expect(submitted!.authType).toBe('basic')
    expect(submitted!.config).toMatchObject({ username: 'e2e-user', password: 'e2e-secret' })
  })

  test('a credential the API rejects tells the user, rather than appearing to save', async ({ page }) => {
    // The branch people actually hit — a typo'd key. A dialog that closed on a
    // 422 would silently discard the user's secret and leave a credential that
    // does not work, which is worse than an error.
    await page.route('**/api/http-credentials', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      await route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          error: 'The API rejected these credentials with HTTP 401.',
          code: 'CREDENTIAL_REJECTED',
        }),
      })
    })

    await page.goto('/credentials')
    const create = page.getByRole('button', { name: 'New credential' })
    await expect(create).toBeVisible({ timeout: 30_000 })
    await create.click()

    await page.locator('#credential-url').fill('https://api.example.com/v1/me')
    await page.locator('#credential-name').fill('E2E rejected credential')
    await page.locator('#credential-username').fill('wrong')
    await page.locator('#credential-password').fill('wrong')
    await page.getByRole('button', { name: 'Verify & save' }).click()

    await expect(page.getByText(/rejected these credentials|could not verify/i).first()).toBeVisible({ timeout: 30_000 })
    // The dialog stays open with the user's work intact.
    await expect(page.getByText('Set up HTTP credential')).toBeVisible()
  })
})

test('connecting an app account asks for a session token for that integration', async ({ page }) => {
  // STUBBED BOUNDARY: the Nango Connect UI. We fulfil the session-token call
  // with a failure precisely so the iframe never opens — the assertion is that
  // we asked for the right thing and told the user when we could not proceed.
  let requestedIntegrationId: string | null = null
  await page.route('**/api/nango/session-token', async (route) => {
    requestedIntegrationId = (route.request().postDataJSON() ?? {}).integrationId ?? null
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'Unable to start the connection flow', code: 'NANGO_UNAVAILABLE' }),
    })
  })

  await page.goto('/integrations')
  const connect = page.getByRole('button', { name: 'Connect', exact: true }).first()
  const available = await connect.isVisible({ timeout: 30_000 }).catch(() => false)
  test.skip(
    !available,
    'This deployment exposes no connectable Nango integrations (GET /api/nango/integrations returned none), ' +
      'so the connect journey has nothing to click. Configure NANGO_SECRET_KEY / the Nango integrations list to cover it.',
  )

  await connect.click()

  await expect(
    page.getByText(/Unable to start the connection flow|Unable to connect account/).first(),
    'the connect failure was not reported to the user',
  ).toBeVisible({ timeout: 30_000 })
  expect(requestedIntegrationId, 'no session token was requested for any integration').toBeTruthy()
})

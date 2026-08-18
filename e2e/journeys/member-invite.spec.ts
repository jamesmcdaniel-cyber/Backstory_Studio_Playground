/**
 * Journey: invite a member, and the invite-link path.
 *
 * ── What is real ─────────────────────────────────────────────────────────
 * The invitation itself. POST /api/organizations/invitations is called for
 * real, a row is written, and the pending list is read back from the server.
 * The invitation is then revoked through the UI, so the spec cleans up through
 * the same surface it tests.
 *
 * ── What is stubbed, and why it has to be ────────────────────────────────
 * The RECIPIENT's side. Accepting an invitation calls
 * `transferUserToOrganization`, which MOVES the accepting user into the
 * inviting workspace — the user↦organization relation is single-valued. If
 * this suite's own test user accepted, it would leave its workspace and every
 * subsequent run would be authenticating into a different tenant than the one
 * it seeded. Accepting for real needs a second, disposable identity, which
 * needs a second Supabase user provisioned per run.
 *
 * So the landing page is driven with GET /api/invitations/lookup stubbed at
 * the network boundary (`page.route`). That call is a pure client-side fetch,
 * so the stub is clean, and what is being asserted — that a recipient sees who
 * invited them and is offered the right door depending on whether they are
 * signed in — is entirely client-side rendering of that response. The ACCEPT
 * transaction remains uncovered; it is exercised by the API-level tests under
 * src/app/api/invitations/__tests__.
 */
import { expect, test } from '../support/fixtures'
import { revokeInvitationsFor } from '../support/seed'

const INVITE_PREFIX = 'e2e-invitee+'

test('an admin invites a teammate and can revoke the pending invitation', async ({ page, workspace }) => {
  const email = `${INVITE_PREFIX}${Date.now()}@example.com`

  await page.goto('/settings?tab=members')
  const invite = page.getByLabel('Invite by email')

  // A non-admin has no invite form at all. Saying so is kinder than a
  // ten-second timeout on a field that was never going to exist.
  await expect(
    invite,
    'no invite form — the test user lacks the members.manage permission, so this journey cannot be driven',
  ).toBeVisible({ timeout: 30_000 })

  await invite.fill(email)
  await page.getByRole('button', { name: 'Send invite' }).click()

  // The pending list is server data, re-read after the POST — so seeing the
  // address here means the invitation was actually persisted, not merely
  // appended to local state.
  const row = page.getByText(email, { exact: true })
  await expect(row, 'the invited address never appeared in the pending list').toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/Pending · (Member|Admin|Viewer|Super admin)/).first()).toBeVisible()

  // Revoke through the UI, which is both the cleanup and a second assertion.
  await page
    .locator('li, div')
    .filter({ hasText: email })
    .getByRole('button', { name: 'Revoke' })
    .last()
    .click()
  await expect(row, 'the revoked invitation is still listed as pending').toBeHidden({ timeout: 30_000 })

  await revokeInvitationsFor(workspace.organizationId, INVITE_PREFIX)
})

test('an invitation link tells the recipient which workspace they were invited to', async ({ page }) => {
  // STUBBED BOUNDARY: GET /api/invitations/lookup. See the header comment —
  // accepting for real would move this suite's user out of its own workspace.
  await page.route('**/api/invitations/lookup**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ valid: true, email: 'invitee@example.com', role: 'USER', organizationName: 'Northwind Labs' }),
    })
  })

  await page.goto('/invite/e2e-fake-token')

  // The recipient's two questions — which workspace, and as what — must both
  // be answered before they are asked to click anything.
  await expect(page.getByText('Join Northwind Labs').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/as a member/i)).toBeVisible()
})

test('an expired or unknown invitation says so instead of failing silently', async ({ page }) => {
  // The branch a real recipient is most likely to hit, and the one most likely
  // to regress into a blank page.
  await page.route('**/api/invitations/lookup**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ valid: false }) })
  })

  await page.goto('/invite/e2e-expired-token')

  await expect(page.getByText('Invitation not found')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('This invitation is invalid or has expired. Ask your admin to send a new one.')).toBeVisible()
})

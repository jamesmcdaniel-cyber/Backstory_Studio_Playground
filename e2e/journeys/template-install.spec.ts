/**
 * Journey: install a template from the catalogue.
 *
 * Nothing is stubbed. POST /api/flow-templates/[id]/use runs for real and
 * writes a real draft flow.
 *
 * ── What "install" means here ────────────────────────────────────────────
 * There is no endpoint named install. A flow template is instantiated by
 * "Create flow draft", which copies the template's wired graph into a new
 * draft in this workspace and drops the user into the builder on it. The
 * assertion is therefore the arrival: a template that "installs" but leaves
 * the user on the gallery, or lands them on an empty flow, has not done the
 * thing its button says.
 *
 * ── Why the visible skip ─────────────────────────────────────────────────
 * The gallery is workspace data. A brand-new workspace has no templates, and a
 * spec that quietly passed because there was nothing to click would be the
 * exact failure this suite exists to remove. So the spec asks the API first
 * and, finding nothing, skips with a reason naming what to seed.
 */
import { expect, test } from '../support/fixtures'

test('installing a flow template creates a draft and opens it in the builder', async ({ page }) => {
  const listing = await page.request.get('/api/flow-templates')
  expect(listing.status(), 'the flow-template listing is not reachable').toBe(200)
  const templates = (await listing.json()).templates ?? []
  test.skip(
    templates.length === 0,
    'This workspace has no flow templates, so there is nothing to install. Seed at least one ' +
      'FlowTemplate row (or publish one from a flow via "Save as template") to cover this journey.',
  )

  await page.goto('/flows')
  const install = page.getByRole('button', { name: 'Create flow draft' }).first()
  await expect(
    install,
    'the flow-template gallery rendered no "Create flow draft" action despite templates existing',
  ).toBeVisible({ timeout: 30_000 })

  await install.click()

  // Arrival in the builder on a NEW flow is the outcome the button promises.
  await page.waitForURL(/\/flows\/[^/?]+/, { timeout: 30_000 })

  // And the draft carries the template's work, not an empty canvas — the
  // failure mode where the flow is created but the graph is not copied.
  await expect(page.getByLabel('Flow name')).not.toHaveValue('', { timeout: 30_000 })
  await expect(
    page.getByTestId('step-card').filter({ hasNot: page.locator('[data-node-id="trigger"]') }).first(),
    'the installed template produced a flow with no steps',
  ).toBeVisible({ timeout: 30_000 })
})

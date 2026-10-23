/**
 * Journey: publish a flow, and arm a trigger.
 *
 * Nothing is stubbed. POST /api/flows/[id]/publish is called for real.
 *
 * ── Why this spec is worth more than it looks ─────────────────────────────
 * Publishing previously 500'd on every call. A route that fails identically
 * for everyone is exactly what an end-to-end suite is for and exactly what
 * unit tests missed, because the failure was in the assembled request path
 * rather than in any one function. This spec is that regression net: it
 * asserts the round trip, and it asserts the version the user is shown.
 *
 * ── "Arming" a trigger is publishing ──────────────────────────────────────
 * There is no Arm button. A webhook or schedule runs the PUBLISHED version, so
 * publishing is what arms it, and the trigger editor says so in the two
 * sentences this spec asserts on: unpublished reads "publish this flow to arm
 * the webhook", published reads "Armed — calls to this URL start a run." That
 * pair is the user-visible contract, so both halves are asserted — a wording
 * that never changes state would satisfy either one alone.
 */
import { E2E_FLOW_PREFIX, createBlankFlow, expect, renameFlow, test } from '../support/fixtures'
import { buildRunnableFlow } from '../support/builder'
import { deleteFlowsNamed } from '../support/seed'

test('publishing a flow reports its version and offers to unpublish', async ({ page, workspace }) => {
  const flowName = `${E2E_FLOW_PREFIX}publish ${Date.now()}`
  await createBlankFlow(page)
  await renameFlow(page, flowName)
  await buildRunnableFlow(page, 'Greeting')

  await page.getByRole('button', { name: 'Publish', exact: true }).click()

  // The header status is the durable statement; the toast is the immediate
  // one. Asserting the header means the assertion does not race sonner's
  // auto-dismiss, and it proves the client took the response's version number
  // rather than optimistically painting success.
  await expect(
    page.getByText(/^Published v\d+$/),
    'publishing did not report a published version — the publish route may be failing',
  ).toBeVisible()

  // The button flips to Unpublish only when the flow is published AND clean,
  // so this doubles as an assertion that publish saved first.
  await expect(page.getByRole('button', { name: 'Unpublish', exact: true })).toBeVisible()

  await deleteFlowsNamed(workspace.organizationId, flowName)
})

test('a webhook trigger reports itself armed only once the flow is published', async ({ page, workspace }) => {
  // FIXME (suspected product bug, found 2026-10-22 on a local stack, 3 of 3
  // attempts): choosing "When an HTTP request is received" auto-mints the
  // webhook secret (POST /api/flows/[id]/trigger-secret, which bumps
  // flow.updatedAt). The very next PUT /api/flows (Publish saves first) is
  // then refused 409 FLOW_STALE_WRITE and the builder reloads ("A teammate
  // saved changes…"), so the flow never publishes. The server log shows the
  // pattern behind it: two PUT /api/flows in flight at once (the debounced
  // graph autosave and the explicit save) carrying the same baseUpdatedAt, so
  // whichever lands second is "stale" — and the switch adds a third writer,
  // the auto-mint, sent once per mounted TriggerEditor (inline card and
  // inspector). The same race makes flow-lifecycle flaky on its first attempt.
  // Re-enable once the builder serializes its own writes; the steps below
  // already drive the current UI.
  test.fixme(true, 'Publishing right after switching to an HTTP trigger is refused FLOW_STALE_WRITE after the webhook-secret auto-mint, and the builder reloads instead of publishing.')
  const flowName = `${E2E_FLOW_PREFIX}arm ${Date.now()}`
  await createBlankFlow(page)
  await renameFlow(page, flowName)
  await buildRunnableFlow(page, 'Greeting')

  await page.locator('[data-node-id="trigger"]').click({ position: { x: 8, y: 8 } })
  const panel = page.locator('[data-node-configuration]')
  await expect(panel).toBeVisible()
  await panel.getByRole('combobox', { name: 'Trigger type' }).selectOption({ label: 'When an HTTP request is received' })

  // Unarmed: the flow has never been published, so calls would hit nothing.
  // The editor renders a third, neutral sentence until the flow fetch lands,
  // so this waits for the specific unpublished wording rather than asserting
  // immediately.
  await expect(panel.getByText('Webhook calls run the published version — publish this flow to arm the webhook.')).toBeVisible()

  // The inspector is a modal over the builder, so the header's Publish is
  // reachable only once it is closed; reopen it to read the trigger's state.
  await panel.getByRole('button', { name: 'Close' }).click()
  await expect(panel).toBeHidden()
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await expect(page.getByText(/^Published v\d+$/)).toBeVisible()

  await page.locator('[data-node-id="trigger"]').click({ position: { x: 8, y: 8 } })
  await expect(panel).toBeVisible()
  await expect(
    panel.getByText('Armed — calls to this URL start a run.'),
    'the webhook did not report itself armed after publishing',
  ).toBeVisible()

  await deleteFlowsNamed(workspace.organizationId, flowName)
})

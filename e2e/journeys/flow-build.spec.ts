/**
 * Journey: build a flow on the canvas — add a step, configure it, save it.
 *
 * Nothing is stubbed. Every request in this spec goes to the real application
 * and the real database: the flow is created by POST /api/flows, the graph is
 * persisted by PUT /api/flows, and the reload at the end reads it back.
 *
 * The reload is the assertion that matters. A builder that renders an added
 * step but never persists it looks correct in every screenshot and loses the
 * user's work the moment they navigate — which is the one bug a build journey
 * exists to catch, and the one a "the step appeared" assertion cannot see.
 */
import { E2E_FLOW_PREFIX, createBlankFlow, expect, renameFlow, test } from '../support/fixtures'
import { addComposeStep, configureComposeInput, inspector, renameStep, saveFlow } from '../support/builder'
import { deleteFlowsNamed } from '../support/seed'

test('a step added, configured, and saved survives a reload', async ({ page, workspace }) => {
  const flowName = `${E2E_FLOW_PREFIX}build ${Date.now()}`
  const stepName = 'Greeting'

  await createBlankFlow(page)
  await renameFlow(page, flowName)

  await addComposeStep(page)
  await expect(inspector(page).getByRole('heading', { name: /Compose|Configure step/ })).toBeVisible()

  await configureComposeInput(page, 'hello from the end-to-end suite')
  await renameStep(page, stepName)

  // The rename reaches the canvas, not just the inspector field — the card is
  // what the user actually reads when the inspector is closed.
  await inspector(page).getByRole('button', { name: 'Close' }).click()
  await expect(page.getByText(stepName, { exact: true }).first()).toBeVisible()

  await saveFlow(page)

  await page.reload()
  await expect(page.getByLabel('Flow name')).toHaveValue(flowName)
  await expect(
    page.getByText(stepName, { exact: true }).first(),
    'the saved step was not present after a reload — the graph did not persist',
  ).toBeVisible()

  // And the configuration persisted too, not merely the step's existence.
  const card = page.getByTestId('step-card').filter({ hasNot: page.locator('[data-node-id="trigger"]') }).last()
  await card.click({ position: { x: 8, y: 8 } })
  await expect(inspector(page).getByRole('textbox', { name: 'Input', exact: true })).toContainText(
    'hello from the end-to-end suite',
  )

  // Best-effort tidy-up. Without a database URL the flow simply stays in the
  // workspace under its recognisable E2E prefix; that is untidy, never wrong.
  await deleteFlowsNamed(workspace.organizationId, flowName)
})

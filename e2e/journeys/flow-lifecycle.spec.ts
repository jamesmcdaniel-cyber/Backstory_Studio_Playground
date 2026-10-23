/**
 * Journey: the core loop end to end — create a flow, give it a code step, run
 * it, watch it finish, and delete it.
 *
 * Nothing is stubbed. The JavaScript step (`return input;`) executes in the
 * application's real sandboxed code runtime, and has no side effect outside
 * this workspace: no integration, no credential, no network call, no model.
 *
 * ── Why delete is part of the journey, not just its cleanup ──────────────
 * Deleting through the UI is a user path in its own right (the confirm
 * dialog, the list updating) and it is also what keeps the suite repeatable:
 * a flow's runs cascade with it, which hands the test user's daily run
 * allowance back, so CI can run this on every push without a database secret.
 * If an earlier step fails, the flowCleanup fixture deletes it through the API.
 */
import { E2E_FLOW_PREFIX, createBlankFlow, expect, renameFlow, test } from '../support/fixtures'
import { addJavaScriptStep, inspector, runsPanel, runsToggle, saveFlow } from '../support/builder'
import { grantFreshRunAllowance } from '../support/seed'

test('a flow with a code step is created, runs to success with the runs panel open, and is deleted', async ({ page, workspace }) => {
  await grantFreshRunAllowance(workspace.userId)
  const flowName = `${E2E_FLOW_PREFIX}lifecycle ${Date.now()}`
  const flowId = await createBlankFlow(page)

  await renameFlow(page, flowName)
  await addJavaScriptStep(page)
  await expect(inspector(page)).toBeVisible()
  await inspector(page).getByRole('button', { name: 'Close' }).click()
  await saveFlow(page)

  await expect(runsToggle(page), 'the runs panel was open before the run — the auto-open check below would be vacuous').toHaveAttribute('aria-pressed', 'false')
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(runsToggle(page), 'starting a run did not open the Runs panel').toHaveAttribute('aria-pressed', 'true')
  await expect(runsPanel(page)).toBeVisible()
  await expect(
    runsPanel(page).getByText(/^succeeded/i).first(),
    'the code-step run never reached succeeded — see the step statuses in the trace',
  ).toBeVisible({ timeout: 120_000 })

  // Delete from the flows list, the way a person tidies up.
  await page.goto('/flows')
  await page.getByLabel('Search flows by name or description').fill(flowName)
  await page.getByRole('button', { name: `Actions for ${flowName}` }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  const confirm = page.getByRole('dialog', { name: 'Delete this flow?' })
  await expect(confirm).toContainText(flowName)
  // The list drops the row optimistically, before the DELETE lands: wait for
  // the server's answer, or the check below can race the delete.
  const deleted = page.waitForResponse((response) => response.request().method() === 'DELETE' && new URL(response.url()).pathname === '/api/flows')
  await confirm.getByRole('button', { name: 'Delete flow' }).click()
  expect((await deleted).ok(), 'the flow DELETE succeeded').toBe(true)
  await expect(page.getByRole('button', { name: `Actions for ${flowName}` })).toHaveCount(0)

  // Gone on the server too, not just from the list's local state.
  const listing = (await (await page.request.get('/api/flows')).json()) as { flows: Array<{ id: string }> }
  expect(listing.flows.some((flow) => flow.id === flowId), 'the deleted flow is still returned by GET /api/flows').toBe(false)
})

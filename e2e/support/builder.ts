/**
 * Driving the flow builder.
 *
 * ── Why every journey builds the same one step ────────────────────────────
 * "Compose" (a `data` step with op `compose`) is the only step in the catalog
 * that is genuinely self-contained: it needs no connected integration, no
 * credential, and no model call, so a flow built from it runs to `succeeded`
 * on a workspace with nothing set up. Any journey that needs a RUNNABLE flow
 * therefore builds this one — not because it is interesting, but because a
 * run assertion should fail when the RUN broke, never when an unrelated
 * integration was missing.
 *
 * ── Selector fragility, stated plainly ────────────────────────────────────
 * There is not a single `data-testid` in this application's production code,
 * so everything here hangs off accessible names, placeholders, and the two
 * structural attributes that do exist (`data-node-id` on step cards and
 * `data-node-configuration` on the inspector root). Copy edits will break
 * these. The selectors are centralised in this file so a copy edit is one fix
 * rather than nine.
 */
import { expect, type Locator, type Page } from '@playwright/test'

/** The inspector panel's root. The only structural hook the drawer offers. */
export function inspector(page: Page): Locator {
  return page.locator('[data-node-configuration]')
}

/** The runs panel's toolbar toggle, whose `aria-pressed` IS the panel's open state. */
export function runsToggle(page: Page): Locator {
  return page.getByRole('button', { name: 'Runs', exact: true })
}

/**
 * Add the Compose step to the open flow and leave its inspector open.
 *
 * The picker row's accessible name concatenates the label and its description,
 * so matching on the description is both unique and resistant to the label
 * "Compose" colliding with any other row.
 */
export async function addComposeStep(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Add step' }).first().click()
  const search = page.getByPlaceholder('Search agents, actions, or connectors')
  await expect(search, 'the step picker did not open').toBeVisible()
  await search.fill('Compose')
  await page.getByRole('button', { name: /Pass a value through so later steps can reuse it/ }).click()

  // Adding a step does not reliably leave the inspector open (in the canvas
  // view any selection change closes it), so open it explicitly rather than
  // depending on that side effect.
  const step = page.locator('[data-node-id]').filter({ hasNot: page.locator('[data-node-id="trigger"]') })
  await openStepInspector(page, step.last())
}

/** Open a step card's inspector, tolerating the click-versus-drag ambiguity. */
export async function openStepInspector(page: Page, card: Locator): Promise<void> {
  if (await inspector(page).isVisible()) return
  // A plain click() can be interpreted as a micro-drag on the canvas, which
  // selects the node without opening the drawer. Clicking the card's centre
  // with no movement is the reliable form.
  await card.click({ position: { x: 8, y: 8 } })
  await expect(inspector(page), 'the step inspector did not open').toBeVisible()
}

/**
 * Give the open Compose step something to work with.
 *
 * Not decoration: `validate.ts` raises MISSING_DATA_INPUT for a `data` step
 * with an empty input, and that is an ERROR, so a flow without this cannot be
 * run or published at all.
 */
export async function configureComposeInput(page: Page, value: string): Promise<void> {
  // A contentEditable role=textbox (TokenTextEditor), scoped to the inspector
  // because the workspace layout also labels its left pane "Input".
  const input = inspector(page).getByRole('textbox', { name: 'Input', exact: true })
  await input.fill(value)
  await expect(input).toContainText(value)
}

/** Rename the open step. The card label follows, which is what we assert on. */
export async function renameStep(page: Page, name: string): Promise<void> {
  const field = inspector(page).getByPlaceholder('A short name for this step')
  await field.fill(name)
  await field.blur()
}

/**
 * Save explicitly rather than waiting out the 2 s autosave debounce.
 *
 * Name and description changes are NOT autosaved — only the graph is — so an
 * explicit save is the only thing that persists both halves of an edit.
 */
export async function saveFlow(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Save now' }).click()
  await expect(
    page.locator('[title="Unsaved changes"]'),
    'the unsaved-changes indicator never cleared after Save now',
  ).toHaveCount(0)
}

/** Build the smallest flow that actually runs, and save it. */
export async function buildRunnableFlow(page: Page, stepName: string): Promise<void> {
  await addComposeStep(page)
  await configureComposeInput(page, 'hello from the end-to-end suite')
  await renameStep(page, stepName)
  await inspector(page).getByRole('button', { name: 'Close' }).click()
  await saveFlow(page)
}

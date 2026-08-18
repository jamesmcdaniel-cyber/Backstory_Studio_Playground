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
 * A first pass at this suite found the app had not one `data-testid` in its
 * production code, so everything hung off accessible names and placeholders
 * — and `aria-label="Close"` (five panels) / `aria-label="Add step"` (three
 * controls) made some of those names ambiguous. The highest-value anchors
 * (Runs panel + its toggle, the picker search input, step cards / the step
 * list) now carry stable `data-testid`s; this file prefers those, falling
 * back to copy-based selectors only where a testid would add nothing (e.g.
 * `configureComposeInput`, which already scopes to the inspector root).
 */
import { expect, type Locator, type Page } from '@playwright/test'

/** The inspector panel's root. The only structural hook the drawer offers. */
export function inspector(page: Page): Locator {
  return page.locator('[data-node-configuration]')
}

/** The Runs panel's root (`src/components/flows/run-panel.tsx`). */
export function runsPanel(page: Page): Locator {
  return page.getByTestId('runs-panel')
}

/** The runs panel's toolbar toggle, whose `aria-pressed` IS the panel's open state. */
export function runsToggle(page: Page): Locator {
  return page.getByTestId('runs-panel-toggle')
}

/**
 * Add the Compose step to the open flow and leave its inspector open.
 *
 * The picker row's accessible name concatenates the label and its description,
 * so matching on the description is both unique and resistant to the label
 * "Compose" colliding with any other row.
 */
export async function addComposeStep(page: Page): Promise<void> {
  // `step-add-inline` disambiguates from the two other "Add step" controls
  // (the canvas view's standalone button and its per-handle add buttons) —
  // `.first()` still picks the insertion point right after the trigger, since
  // the inline chain repeats this control at every gap.
  await page.getByTestId('step-add-inline').first().click()
  const search = page.getByTestId('picker-search')
  await expect(search, 'the step picker did not open').toBeVisible()
  await search.fill('Compose')
  await page.getByRole('button', { name: /Pass a value through so later steps can reuse it/ }).click()

  // Adding a step does not reliably leave the inspector open (in the canvas
  // view any selection change closes it), so open it explicitly rather than
  // depending on that side effect.
  const step = page.getByTestId('step-card').filter({ hasNot: page.locator('[data-node-id="trigger"]') })
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

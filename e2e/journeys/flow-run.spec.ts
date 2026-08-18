/**
 * Journey: run a flow and see the result — and the runs-panel invariant.
 *
 * Nothing is stubbed. The Compose step executes for real in the application's
 * own runtime, which is the point: a stubbed run would assert that a spinner
 * spins.
 *
 * ── The invariant this spec exists to protect ─────────────────────────────
 * Starting a run MUST auto-open the Runs panel, so the run narrates itself in
 * realtime. This is a product mandate (src/app/flows/[id]/page.tsx, `run()`:
 * `setActivePanel('runs')`), it has regressed before, and the regression is
 * invisible to every other kind of test — the run still succeeds, the data is
 * still correct, and the user is simply left staring at a canvas that says
 * nothing is happening. Hence the assertion is made on the panel's state
 * BEFORE and AFTER, not merely on it being open at the end: a panel the user
 * had already opened would satisfy the weaker assertion forever.
 *
 * ── The one non-assertion ─────────────────────────────────────────────────
 * Run STATUS text is asserted case-insensitively and only in its terminal
 * state. While a run is in flight the panel renders a TypewriterStatus that
 * animates character by character, and the narration lines come from a model,
 * so neither is assertable content. The panel being OPEN is the assertable
 * part of realtime narration, and it is what the mandate is actually about.
 */
import { E2E_FLOW_PREFIX, createBlankFlow, expect, renameFlow, test } from '../support/fixtures'
import { buildRunnableFlow, runsToggle } from '../support/builder'
import { deleteFlowsNamed, grantFreshRunAllowance } from '../support/seed'

test.describe('running a flow', () => {
  test.beforeEach(async ({ workspace }) => {
    // Best-effort, and deliberately not a hard requirement: without a database
    // URL this does nothing and the run below may be refused by the 5-per-day
    // ceiling on its sixth CI run of the day. That failure is self-describing
    // ("You have used all 5 flow runs for today"), so it costs a diagnosis
    // rather than a mystery. Making it mandatory would force every browser run
    // to hold database credentials it otherwise does not need.
    await grantFreshRunAllowance(workspace.userId)
  })

  test('starting a run opens the runs panel and the run reaches a terminal state', async ({ page, workspace }) => {
    const flowName = `${E2E_FLOW_PREFIX}run ${Date.now()}`
    await createBlankFlow(page)
    await renameFlow(page, flowName)
    await buildRunnableFlow(page, 'Greeting')

    // The "before" half of the invariant. Without it, a panel that was already
    // open would make the "after" assertion meaningless.
    await expect(
      runsToggle(page),
      'the runs panel was already open before the run started — the auto-open assertion below would be vacuous',
    ).toHaveAttribute('aria-pressed', 'false')

    await page.getByRole('button', { name: 'Run', exact: true }).click()

    // THE INVARIANT. Both halves: the toggle reports pressed, and the panel is
    // actually rendered. Either alone could pass while the user sees nothing.
    await expect(
      runsToggle(page),
      'REGRESSION: starting a run did not auto-open the Runs panel (src/app/flows/[id]/page.tsx run() must setActivePanel("runs"))',
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('heading', { name: 'Runs', level: 2 })).toBeVisible()

    // The result the user came for. Statuses render lowercase in the DOM and
    // are capitalised by CSS, so the match must be case-insensitive.
    await expect(
      page.getByText(/^succeeded/i).first(),
      'the run never reached succeeded — check the step statuses in the attached trace',
    ).toBeVisible({ timeout: 120_000 })

    await deleteFlowsNamed(workspace.organizationId, flowName)
  })

  test('a run started from the runs panel keeps the panel open', async ({ page, workspace }) => {
    // The second entry point into the same mandate. The panel's own Run button
    // must not close the panel it lives in — a plausible regression when the
    // panel state is refactored, and one the toolbar path would not catch.
    const flowName = `${E2E_FLOW_PREFIX}panel-run ${Date.now()}`
    await createBlankFlow(page)
    await renameFlow(page, flowName)
    await buildRunnableFlow(page, 'Greeting')

    await runsToggle(page).click()
    await expect(page.getByRole('heading', { name: 'Runs', level: 2 })).toBeVisible()

    // Two buttons are named "Run" once the panel is open: the toolbar's, which
    // renders first, and the panel's own, which renders after it. `.last()` is
    // the panel's — a positional selector, and the honest one, because neither
    // button carries anything to distinguish it by name.
    const runButtons = page.getByRole('button', { name: 'Run', exact: true })
    await expect(runButtons, 'expected both the toolbar and panel Run buttons').toHaveCount(2)
    await runButtons.last().click()

    await expect(runsToggle(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText(/^succeeded/i).first()).toBeVisible({ timeout: 120_000 })

    await deleteFlowsNamed(workspace.organizationId, flowName)
  })
})

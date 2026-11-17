/**
 * Journey: a busy day of runs is never refused.
 *
 * The per-person daily run caps were lifted for every user on 2026-11-17
 * (FREE_TIER_LIMITS run ceilings are null in src/lib/usage/free-tier-limits.ts).
 * This journey used to prove the cap refused the sixth run; it now proves the
 * opposite through the real execute route, with nothing stubbed — so quietly
 * reinstating a cap fails here, where someone will see it.
 *
 * ── Why this project still runs last, and alone ──────────────────────────
 * Arranging it writes a busy day of run rows for the test user. They are
 * cleared afterwards, but nothing else should start runs while they exist.
 *
 * ── Why it can skip, loudly ──────────────────────────────────────────────
 *  - The busy day is arranged server-side (E2E_DATABASE_URL).
 *  - A super-admin test user (catalogue.review) was never capped, so for them
 *    this would assert nothing. Both are announced as skips naming the fix.
 */
import { E2E_FLOW_PREFIX, createBlankFlow, expect, renameFlow, test } from '../support/fixtures'
import { buildRunnableFlow } from '../support/builder'
import { BUSY_DAY_FLOW_RUNS } from '../support/limits'
import { seedSkipReason } from '../support/env'
import { clearSeededRuns, deleteFlowsNamed, fillDailyFlowRunAllowance, grantFreshRunAllowance } from '../support/seed'

test.describe.configure({ mode: 'serial' })

test('a person with a busy day of flow runs still starts another — no daily cap', async ({ page, workspace }) => {
  const seedReason = seedSkipReason()
  test.skip(Boolean(seedReason), seedReason ?? '')
  test.skip(
    workspace.canReview,
    'The end-to-end user holds catalogue.review and was never capped (isUnlimitedActor). ' +
      'Point E2E_USER_EMAIL at a plain ADMIN or USER account to cover this journey.',
  )

  const flowName = `${E2E_FLOW_PREFIX}busy-day ${Date.now()}`
  const flowId = await createBlankFlow(page)
  await renameFlow(page, flowName)
  await buildRunnableFlow(page, 'Greeting')

  try {
    await grantFreshRunAllowance(workspace.userId)
    await fillDailyFlowRunAllowance({
      organizationId: workspace.organizationId,
      userId: workspace.userId,
      flowId,
      count: BUSY_DAY_FLOW_RUNS,
    })

    // At the API, because the route is reachable directly and is where a cap
    // would be enforced.
    const response = await page.request.post(`/api/flows/${flowId}/execute`, { data: {} })
    const body = await response.json().catch(() => ({}))
    expect(response.status(), JSON.stringify(body)).not.toBe(429)
    expect(body.code).not.toBe('DAILY_LIMIT_REACHED')

    // And in the builder: Run starts a run, with no limit sentence anywhere.
    await page.getByRole('button', { name: 'Run', exact: true }).click()
    await expect(page.getByText(/runs for today/)).toHaveCount(0)
  } finally {
    await clearSeededRuns(flowId)
    await grantFreshRunAllowance(workspace.userId)
    await deleteFlowsNamed(workspace.organizationId, flowName)
  }
})

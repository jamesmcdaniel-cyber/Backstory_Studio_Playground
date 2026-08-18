/**
 * Journey: hit the free-tier ceiling and be told, in plain English, why.
 *
 * Nothing is stubbed. The refusal comes from the real gate in
 * src/lib/usage/free-tier-limits.ts, reached through the real execute route.
 * Stubbing a 429 and asserting the toast would test only that sonner renders
 * text — it would keep passing if the ceiling were removed entirely, which is
 * the single failure this spec exists to catch.
 *
 * ── Why this project runs last, and alone ────────────────────────────────
 * Arranging this journey means SPENDING the test user's daily allowance, and
 * the allowance is per person per UTC day. Any other journey that started a
 * run afterwards would be refused for reasons of its own. So this file is its
 * own Playwright project, declared to depend on the authenticated project, and
 * it restores a fresh allowance afterwards.
 *
 * ── Why it can skip, loudly ──────────────────────────────────────────────
 * Two preconditions cannot be met from the browser:
 *  - A refusal must be arranged server-side (E2E_DATABASE_URL).
 *  - The actor must not be exempt. Anyone holding `catalogue.review` bypasses
 *    every ceiling, so a super-admin test user can NEVER produce this refusal
 *    and a spec that "passed" for them would be asserting nothing.
 * Both are announced as skips naming the fix, never as silent passes.
 */
import { E2E_FLOW_PREFIX, createBlankFlow, expect, renameFlow, test } from '../support/fixtures'
import { buildRunnableFlow } from '../support/builder'
import { FREE_TIER_FLOW_RUNS_PER_DAY, LIMIT_MESSAGE } from '../support/limits'
import { seedSkipReason } from '../support/env'
import { clearSeededRuns, deleteFlowsNamed, fillDailyFlowRunAllowance, grantFreshRunAllowance } from '../support/seed'

test.describe.configure({ mode: 'serial' })

test('a person who has used their daily runs is refused, and told when it resets', async ({ page, workspace }) => {
  const seedReason = seedSkipReason()
  test.skip(Boolean(seedReason), seedReason ?? '')
  test.skip(
    workspace.canReview,
    'The end-to-end user holds catalogue.review and is therefore exempt from every free-tier ceiling ' +
      '(isUnlimitedActor). Point E2E_USER_EMAIL at a plain ADMIN or USER account to cover this journey.',
  )

  const flowName = `${E2E_FLOW_PREFIX}limit ${Date.now()}`
  const flowId = await createBlankFlow(page)
  await renameFlow(page, flowName)
  await buildRunnableFlow(page, 'Greeting')

  try {
    // Start from a known window, then consume exactly the allowance. Doing
    // both makes the arrangement independent of whatever else ran today.
    await grantFreshRunAllowance(workspace.userId)
    await fillDailyFlowRunAllowance({
      organizationId: workspace.organizationId,
      userId: workspace.userId,
      flowId,
      count: FREE_TIER_FLOW_RUNS_PER_DAY,
    })

    await page.getByRole('button', { name: 'Run', exact: true }).click()

    // The exact sentence, not a substring of it and not a status code: this is
    // the whole of what the user gets, and "you have hit a limit" is only
    // useful if it also says which limit and when it lifts.
    await expect(
      page.getByText(LIMIT_MESSAGE.flowRuns(FREE_TIER_FLOW_RUNS_PER_DAY)),
      'the daily run ceiling did not refuse the run, or refused it without telling the user why',
    ).toBeVisible({ timeout: 30_000 })
  } finally {
    // Restore the account before anything else touches it, even on failure.
    await clearSeededRuns(flowId)
    await grantFreshRunAllowance(workspace.userId)
    await deleteFlowsNamed(workspace.organizationId, flowName)
  }
})

test('the refusal is the server\'s, not the page\'s', async ({ page, workspace }) => {
  const seedReason = seedSkipReason()
  test.skip(Boolean(seedReason), seedReason ?? '')
  test.skip(workspace.canReview, 'The end-to-end user is exempt from the free-tier ceilings (catalogue.review).')

  const flowName = `${E2E_FLOW_PREFIX}limit-api ${Date.now()}`
  const flowId = await createBlankFlow(page)
  await renameFlow(page, flowName)
  await buildRunnableFlow(page, 'Greeting')

  try {
    await grantFreshRunAllowance(workspace.userId)
    await fillDailyFlowRunAllowance({
      organizationId: workspace.organizationId,
      userId: workspace.userId,
      flowId,
      count: FREE_TIER_FLOW_RUNS_PER_DAY,
    })

    // Asserted at the API as well as in the UI, because a ceiling enforced only
    // in the client is not a ceiling — the route is reachable directly.
    const refused = await page.request.post(`/api/flows/${flowId}/execute`, { data: {} })
    expect(refused.status()).toBe(429)
    const body = await refused.json()
    expect(body.code).toBe('DAILY_LIMIT_REACHED')
    expect(body.error).toBe(LIMIT_MESSAGE.flowRuns(FREE_TIER_FLOW_RUNS_PER_DAY))
  } finally {
    await clearSeededRuns(flowId)
    await grantFreshRunAllowance(workspace.userId)
    await deleteFlowsNamed(workspace.organizationId, flowName)
  }
})

/**
 * Journey: create an agent and run it.
 *
 * ── What is real ─────────────────────────────────────────────────────────
 * The agent. It is created through the real manual configuration form and
 * persisted by POST /api/agents, and it is then found and started from the
 * real roster.
 *
 * ── STUBBED BOUNDARY: POST /api/agents/[id]/execute ──────────────────────
 * The model call is made SERVER-SIDE — `new Anthropic({ apiKey })` in
 * src/lib/llm/model-runner.ts, reaching api.anthropic.com from the Next.js
 * server or, under EXECUTION_MODE=queue, from a separate worker process.
 * Playwright's `page.route` intercepts the BROWSER's network, so it cannot
 * reach that call at all: there is no boundary between the click and the model
 * that a browser test can stand on except our own execute route.
 *
 * So the execute route is stubbed. This is deliberate and it is a real limit
 * on what this spec proves: the agent RUNTIME — planning, tool use, budgets,
 * the queue — is not covered here, and is covered instead by
 * src/features/agents/__tests__ and the nightly eval suite. What IS covered is
 * the journey a person takes: configure an agent, find it on the roster, start
 * it, and be told what happened — including the failure branch, which is the
 * one a model outage produces.
 *
 * Stubbing also keeps the suite from spending real model credits on every pull
 * request, which a live run would.
 */
import { expect, test } from '../support/fixtures'

const AGENT_PREFIX = 'E2E agent '

async function createAgent(page: import('@playwright/test').Page, title: string): Promise<void> {
  await page.goto('/agents')
  await page.getByRole('button', { name: 'New agent' }).first().click()
  await page.getByRole('button', { name: 'Set up manually' }).click()

  await page.locator('#agent-name').fill(title)
  await page.locator('#agent-instructions').fill('Reply with a single word: acknowledged.')
  await page.getByRole('button', { name: 'Create agent' }).click()

  await expect(
    page.getByRole('button', { name: `Configure ${title}` }),
    'the created agent never appeared on the roster',
  ).toBeVisible({ timeout: 30_000 })
}

test('an agent can be created, started, and reports that it ran', async ({ page }) => {
  const title = `${AGENT_PREFIX}${Date.now()}`

  let executed = false
  await page.route('**/api/agents/*/execute', async (route) => {
    executed = true
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, executionId: 'e2e-execution', result: { status: 'completed', output: 'acknowledged' } }),
    })
  })

  await createAgent(page, title)
  await page.getByRole('button', { name: `Run ${title}` }).click()

  await expect(
    page.getByText(`${title} ran`),
    'starting the agent did not report a completed run to the user',
  ).toBeVisible({ timeout: 30_000 })
  expect(executed, 'the run button never called the execute route').toBe(true)
})

test('an agent run that fails says so instead of appearing to succeed', async ({ page }) => {
  // A model outage, a missing API key, or a refused budget all arrive here as
  // a non-2xx from the execute route. Silence would leave the user believing
  // their agent is working.
  const title = `${AGENT_PREFIX}fail ${Date.now()}`

  await page.route('**/api/agents/*/execute', async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'Agent run failed', code: 'RUN_FAILED' }),
    })
  })

  await createAgent(page, title)
  await page.getByRole('button', { name: `Run ${title}` }).click()

  await expect(page.getByText(/Agent run failed|Run failed/).first()).toBeVisible({ timeout: 30_000 })
})

/**
 * Journey: create an agent, open its chat, send a message, and watch the run
 * surface open — then delete the agent.
 *
 * Nothing is stubbed. POST /api/agents creates the agent for real, and the
 * chat message goes to the real POST /api/agents/[id]/chat.
 *
 * ── What is asserted, and what deliberately is not ───────────────────────
 * The reply comes from a model, server-side. Whether this deployment's keys
 * can reach one is not what this journey tests, and a model answer is not
 * assertable content anyway. What IS the product's promise is the moment
 * after Send: the message lands in the thread and the in-flight run panel
 * ("Working — a live run can take a few minutes…", with a Stop control)
 * opens straight away, so nobody stares at a silent pane while a run works.
 *
 * To assert that moment deterministically the request is HELD in the browser
 * — not answered — until the panel has been checked, then released to the
 * real server unchanged. Afterwards the journey accepts either outcome (a
 * reply in the thread, or an error that says so) and only requires the pane
 * to settle back to a usable composer.
 */
import { expect, test } from '../support/fixtures'
import { deleteAgentsByPrefix } from '../support/api'

const AGENT_PREFIX = 'E2E chat agent '

test('an agent is created, its chat opens the run panel on send, and it is deleted', async ({ page }) => {
  const title = `${AGENT_PREFIX}${Date.now()}`

  try {
    await page.goto('/agents')
    await page.getByRole('button', { name: 'New agent' }).first().click()
    await page.getByRole('button', { name: 'Set up manually' }).click()
    await page.locator('#agent-name').fill(title)
    await page.locator('#agent-instructions').fill('You are an end-to-end test agent. Reply with one short sentence.')
    const created = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/agents' && response.request().method() === 'POST',
    )
    await page.getByRole('button', { name: 'Create agent' }).click()
    expect((await created).status(), 'POST /api/agents refused the new agent').toBe(200)

    // Creating lands in the agent's workspace with its chat beside it.
    await expect(page.getByRole('combobox', { name: 'Select agent' }), 'the new agent did not open').toContainText(title)
    const composer = page.getByRole('textbox', { name: 'Message the assistant' })
    await expect(composer).toBeEnabled()

    // Hold the chat request until the in-flight panel has been asserted.
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let sent = false
    await page.route('**/api/agents/*/chat', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      sent = true
      await held
      await route.continue()
    })

    const message = 'What will you do when you run?'
    await composer.fill(message)
    await page.getByRole('button', { name: 'Send message' }).click()

    await expect(page.getByText(message, { exact: true }), 'the sent message never appeared in the thread').toBeVisible()
    await expect(
      page.getByRole('status').filter({ hasText: 'Working — a live run can take a few minutes' }),
      'sending did not open the in-flight run panel',
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible()
    expect(sent, 'the Send button never called the chat route').toBe(true)

    // Released, not unrouted: unrouting while the handler still holds the
    // request would let Playwright settle it a second time. Once `held`
    // resolves, the handler passes every request straight through.
    release()

    // Settled: a reply or a stated failure — never a pane stuck in flight.
    await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible({ timeout: 180_000 })
    await expect(page.getByRole('status').filter({ hasText: 'Working — a live run' })).toHaveCount(0)

    // Delete through the sidebar, the way a person removes an agent.
    await page.getByRole('button', { name: `Delete ${title}` }).click()
    const confirm = page.getByRole('alertdialog', { name: `Delete ${title}?` }).or(page.getByRole('dialog', { name: `Delete ${title}?` }))
    await confirm.getByRole('button', { name: 'Delete agent' }).click()
    // The sidebar entry going away is the durable signal (the toast is gone in seconds).
    await expect(page.getByRole('button', { name: `Delete ${title}` })).toHaveCount(0)
    // The sidebar drops the entry optimistically, so the server is polled
    // until the DELETE has landed rather than read once.
    await expect
      .poll(async () => {
        const listing = (await (await page.request.get('/api/agents')).json()) as { agents: Array<{ title: string }> }
        return listing.agents.some((agent) => agent.title === title)
      }, { message: 'the deleted agent is still listed by GET /api/agents' })
      .toBe(false)
  } finally {
    // Best effort, and by prefix: a cleanup that fails (a dev server mid-restart)
    // must not fail the journey, and the next run sweeps whatever it left.
    await deleteAgentsByPrefix(page.request, AGENT_PREFIX).catch(() => undefined)
  }
})

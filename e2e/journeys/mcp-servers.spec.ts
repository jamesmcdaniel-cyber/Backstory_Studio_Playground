/**
 * Journey: Integrations → MCP Servers — open a connected server, read its
 * tools, change one tool's permission, and put it back.
 *
 * Nothing is stubbed. The tool list is the server's LIVE tools/list (through
 * the same cached discovery agents use), and the permission is written by the
 * real PATCH route to McpConnection.toolPolicies, which the runtime enforces.
 *
 * ── Which server ──────────────────────────────────────────────────────────
 * The provisioned end-to-end workspace always has one: the Backstory MCP,
 * authorized against the Keyslogic demo tenant (scripts/e2e/connect-test-
 * account.ts), so the tools are real and the data behind them is demo data.
 * The spec does not hard-code it, though: it asks the server which connected
 * servers actually answer tools/list and drives the first one. A connected
 * server that cannot list its tools fails the journey (that is a broken
 * integration, not an empty workspace); a workspace with no server at all
 * skips, naming the fix.
 *
 * ── Leaving it as it was ─────────────────────────────────────────────────
 * The permission is restored through the UI as the second half of the
 * journey, and — should anything in between fail — through the API in a
 * finally block, so a red run never leaves a tool blocked for the next one.
 */
import { expect, test } from '../support/fixtures'
import { mcpServerTools, mcpServers, setToolPolicy, type ToolPolicy } from '../support/api'

const LABEL: Record<ToolPolicy, string> = { allow: 'Always allow', approve: 'Needs approval', off: 'Blocked' }

test('a connected MCP server shows its tools, and a tool permission can be changed and restored', async ({ page }) => {
  const connected = (await mcpServers(page.request)).filter(
    (server) => server.isActive && server.lastVerifiedAt && server.healthStatus !== 'unhealthy',
  )
  test.skip(
    connected.length === 0,
    'No connected MCP server in this workspace. Run scripts/e2e/connect-test-account.ts to authorize the ' +
      'Keyslogic demo Backstory MCP for the test account (docs/e2e-authenticated-setup.md).',
  )

  // The first connected server that actually lists tools.
  const failures: string[] = []
  let chosen: { id: string; name: string; tool: { name: string; title: string; policy: ToolPolicy } } | null = null
  for (const server of connected) {
    const tools = await mcpServerTools(page.request, server.id)
    if (tools.success && tools.items.length > 0) {
      chosen = { id: server.id, name: server.name, tool: tools.items[0] }
      break
    }
    failures.push(`${server.name}: ${tools.error ?? 'no tools'}`)
  }
  expect(chosen, `Every connected MCP server failed to list its tools — ${failures.join('; ')}`).not.toBeNull()
  const { id, name, tool } = chosen!
  const original = tool.policy
  const changed: ToolPolicy = original === 'approve' ? 'allow' : 'approve'

  try {
    await page.goto('/integrations?tab=servers')
    await expect(page.getByRole('tab', { name: 'MCP Servers' })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('button', { name: `${name}: tools and permissions` }).first().click()

    const dialog = page.getByRole('dialog', { name })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('heading', { name: 'Tool permissions' })).toBeVisible()

    // The tool list the server reported, rendered with its permission control.
    const control = dialog.getByRole('radiogroup', { name: `When ${tool.title} may run` })
    await expect(control, `the dialog did not list ${tool.title}`).toBeVisible()
    await expect(control.getByRole('radio', { name: LABEL[original] })).toHaveAttribute('aria-checked', 'true')

    const change = async (policy: ToolPolicy) => {
      const saved = page.waitForResponse(
        (response) => response.url().includes(`/api/mcp-connections/${id}/tools`) && response.request().method() === 'PATCH',
      )
      await control.getByRole('radio', { name: LABEL[policy] }).click()
      expect((await saved).status(), `saving ${LABEL[policy]} was refused`).toBe(200)
      await expect(control.getByRole('radio', { name: LABEL[policy] })).toHaveAttribute('aria-checked', 'true')
    }

    // Change it — and prove it persisted by reading it back from the server,
    // not from the optimistic UI that painted it before the save landed.
    await change(changed)
    const after = await mcpServerTools(page.request, id)
    expect(after.items.find((item) => item.name === tool.name)?.policy, 'the new permission did not persist').toBe(changed)

    // Restore it through the same control.
    await change(original)
    const restored = await mcpServerTools(page.request, id)
    expect(restored.items.find((item) => item.name === tool.name)?.policy, 'the permission was not restored').toBe(original)

    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  } finally {
    await setToolPolicy(page.request, id, tool.name, original)
  }
})

/**
 * Journey: find an artifact, read it, ask the agent about it, ask for a change.
 *
 * ── STUBBED BOUNDARY: /api/artifacts/** ──────────────────────────────────
 * The artifact routes are stubbed so this spec proves the page — the list,
 * the viewer, the version selector, the two chat modes and the
 * pending→answered transition — without a model run or a database row. The
 * registration and reconciliation logic behind those routes is covered by
 * src/lib/artifacts/__tests__ and the DB-backed route smoke.
 */
import { expect, test } from '../support/fixtures'

const ARTIFACT = {
  id: 'art-e2e-1',
  kind: 'report',
  title: 'Q3 pipeline review',
  agent: { id: 'agent-1', title: 'Pipeline analyst' },
  flow: null,
  currentVersionId: 'v2',
  versionCount: 2,
  versions: [
    { id: 'v2', number: 2, executionId: 'exec-2', flowRunId: null, request: 'Add a risks section', createdAt: '2026-09-29T10:00:00.000Z', bytes: 400, format: 'html' },
    { id: 'v1', number: 1, executionId: 'exec-1', flowRunId: null, request: null, createdAt: '2026-09-28T10:00:00.000Z', bytes: 300, format: 'html' },
  ],
  chat: [] as Array<Record<string, unknown>>,
  interactive: false,
  archivedAt: null,
  createdAt: '2026-09-28T10:00:00.000Z',
  updatedAt: '2026-09-29T10:00:00.000Z',
}

test('an artifact can be found, read, questioned and revised', async ({ page }) => {
  let detail = { ...ARTIFACT }
  await page.route('**/api/artifacts?**', (route) => route.fulfill({ json: { success: true, artifacts: [{ id: detail.id, kind: detail.kind, title: detail.title, agent: detail.agent, flow: null, versionCount: 2, updatedAt: detail.updatedAt, createdAt: detail.createdAt }] } }))
  await page.route('**/api/artifacts', (route) => route.fulfill({ json: { success: true, artifacts: [{ id: detail.id, kind: detail.kind, title: detail.title, agent: detail.agent, flow: null, versionCount: 2, updatedAt: detail.updatedAt, createdAt: detail.createdAt }] } }))
  await page.route(`**/api/artifacts/${ARTIFACT.id}`, (route) => route.fulfill({ json: { success: true, artifact: detail } }))
  await page.route(`**/api/artifacts/${ARTIFACT.id}/versions/*/content`, (route) => {
    const version = route.request().url().includes('/v1/') ? 'one' : 'two'
    return route.fulfill({ contentType: 'text/html', body: `<html><body><h1>Q3 pipeline review, version ${version}</h1></body></html>` })
  })
  await page.route(`**/api/artifacts/${ARTIFACT.id}/chat`, async (route) => {
    const body = route.request().postDataJSON() as { message: string; mode: string }
    const now = new Date().toISOString()
    detail = { ...detail, chat: [...detail.chat, { role: 'user', mode: body.mode, content: body.message, createdAt: now }, { role: 'agent', mode: body.mode, content: '', executionId: 'exec-3', status: 'pending', createdAt: now }] }
    await route.fulfill({ json: { success: true, artifact: detail } })
    // The next poll finds the answer (and, for a change, the new version).
    const answered = body.mode === 'change'
      ? { ...detail, currentVersionId: 'v3', versionCount: 3, versions: [{ id: 'v3', number: 3, executionId: 'exec-3', flowRunId: null, request: body.message, createdAt: now, bytes: 500, format: 'html' }, ...detail.versions], chat: detail.chat.map((m) => (m.status === 'pending' ? { ...m, status: 'completed', versionId: 'v3', content: 'Done — a new version is ready.' } : m)) }
      : { ...detail, chat: detail.chat.map((m) => (m.status === 'pending' ? { ...m, status: 'completed', content: 'Win rate rose because **engagement** rose.' } : m)) }
    detail = answered
  })
  await page.route('**/api/workflows/executions?**', (route) => route.fulfill({ json: { success: true, items: [] } }))

  await page.goto('/artifacts')
  await expect(page.getByRole('heading', { name: 'What your agents have produced' })).toBeVisible()
  await page.getByRole('link', { name: /Q3 pipeline review/ }).click()

  await expect(page.getByRole('heading', { name: 'Q3 pipeline review' })).toBeVisible()
  const frame = page.frameLocator('iframe[title="Q3 pipeline review"]')
  await expect(frame.getByRole('heading', { name: 'Q3 pipeline review, version two' })).toBeVisible()

  // Older versions stay readable.
  await page.getByLabel('Version').selectOption('v1')
  await expect(frame.getByRole('heading', { name: 'Q3 pipeline review, version one' })).toBeVisible()

  // Ask a question: pending, then answered.
  await page.getByLabel('Message').fill('Why did win rate rise?')
  await page.getByRole('button', { name: 'Send question' }).click()
  await expect(page.getByText('Working on it…')).toBeVisible()
  await expect(page.getByText('Win rate rose because')).toBeVisible({ timeout: 20_000 })

  // Ask for a change: a new version appears and becomes current.
  await page.getByRole('radio', { name: 'Ask for a change' }).click()
  await page.getByLabel('Message').fill('Add a risks section')
  await page.getByRole('button', { name: 'Send change request' }).click()
  await expect(page.getByText('Revising…')).toBeVisible()
  await expect(page.getByText('Done — a new version is ready.')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByLabel('Version')).toContainText('v3')
})

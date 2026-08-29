import '@/test-support/jsdom-env'
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ContentRepository } from '../content-repository'

const realFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

const asset = (over: Record<string, unknown> = {}) => ({
  id: 'asset-1',
  agentId: null,
  agentName: null,
  filename: 'guide.md',
  description: 'Workspace guide',
  mimeType: 'text/markdown',
  sizeBytes: 128,
  charCount: 128,
  chunkCount: 1,
  hasOriginal: true,
  assetType: 'file',
  sourceType: 'upload',
  sourceProvider: null,
  sourceTool: null,
  isEnabled: true,
  version: 1,
  status: 'ready',
  error: null,
  lastSyncedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  downloadUrl: '/api/repository/asset-1/download',
  ...over,
})

function response(data: unknown, ok = true): Response {
  return { ok, json: async () => data } as unknown as Response
}

test('repository files expose upload, integration pull, provenance, scope, and agent availability', async () => {
  globalThis.fetch = (async () => response({
    success: true,
    assets: [asset(), asset({ id: 'asset-2', filename: 'crm-snapshot.json', sourceType: 'integration', sourceProvider: 'nango:salesforce', sourceTool: 'salesforce_search', hasOriginal: false, isEnabled: false, version: 2 })],
    agents: [{ id: 'agent-1', title: 'Research agent' }],
  })) as typeof fetch

  render(<ContentRepository writable />)

  assert.ok(await screen.findByText('guide.md'))
  assert.ok(screen.getByText('crm-snapshot.json'))
  assert.ok(screen.getByRole('button', { name: /Upload files/i }))
  assert.ok(screen.getByRole('button', { name: /Pull from integration/i }))
  assert.ok(screen.getByText('File upload'))
  assert.ok(screen.getByText('salesforce'))
  assert.ok(screen.getAllByText('All agents').length >= 1)
  assert.equal(screen.getByRole('switch', { name: 'Disable guide.md for agents' }).getAttribute('data-state'), 'checked')
  assert.equal(screen.getByRole('switch', { name: 'Enable crm-snapshot.json for agents' }).getAttribute('data-state'), 'unchecked')
})

test('disabling an asset persists the retrieval gate and updates the row', async () => {
  let current = asset()
  let patchBody: Record<string, unknown> | null = null
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('/api/repository?') && !init?.method) {
      return response({ success: true, assets: [current], agents: [], stats: { total: 1, available: current.isEnabled ? 1 : 0, pulls: 0 } })
    }
    if (url === '/api/repository/asset-1' && init?.method === 'PATCH') {
      patchBody = JSON.parse(String(init.body))
      current = { ...current, isEnabled: false, version: 2 }
      return response({ success: true, asset: current })
    }
    throw new Error(`Unexpected request: ${url}`)
  }) as typeof fetch

  render(<ContentRepository writable />)
  fireEvent.click(await screen.findByRole('switch', { name: 'Disable guide.md for agents' }))

  await waitFor(() => assert.ok(screen.getByRole('switch', { name: 'Enable guide.md for agents' })))
  assert.deepEqual(patchBody, { isEnabled: false, expectedVersion: 1 })
})

test('read-only members can download but cannot mutate repository assets', async () => {
  globalThis.fetch = (async () => response({ success: true, assets: [asset()], agents: [] })) as typeof fetch
  render(<ContentRepository writable={false} />)

  assert.ok(await screen.findByText('guide.md'))
  assert.equal(screen.queryByRole('button', { name: /Upload files/i }), null)
  assert.equal(screen.queryByRole('button', { name: /Pull from integration/i }), null)
  assert.equal(screen.getByRole('switch', { name: 'Disable guide.md for agents' }).hasAttribute('disabled'), true)
})

test('loads repository pages without silently capping the catalogue', async () => {
  const requests: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    requests.push(url)
    if (url.includes('cursor=next-page')) {
      return response({ success: true, assets: [asset({ id: 'asset-2', filename: 'second.md' })], agents: [], nextCursor: null, stats: { total: 2, available: 2, pulls: 0 } })
    }
    return response({ success: true, assets: [asset()], agents: [], nextCursor: 'next-page', stats: { total: 2, available: 2, pulls: 0 } })
  }) as typeof fetch

  render(<ContentRepository writable />)
  fireEvent.click(await screen.findByRole('button', { name: 'Load more files' }))

  assert.ok(await screen.findByText('second.md'))
  assert.ok(screen.getByText('guide.md'))
  assert.ok(requests.some((url) => url.includes('cursor=next-page')))
})

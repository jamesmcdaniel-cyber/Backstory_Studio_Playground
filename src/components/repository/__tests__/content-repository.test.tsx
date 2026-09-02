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
  assert.ok(screen.getByRole('button', { name: /Sync GitHub/i }))
  assert.ok(screen.getByRole('button', { name: /New project/i }))
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
  assert.equal(screen.queryByRole('button', { name: /Sync GitHub/i }), null)
  assert.equal(screen.queryByRole('button', { name: /New project/i }), null)
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

test('saves a project with an explicit reference scope', async () => {
  let submitted: Record<string, unknown> | null = null
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('/api/repository?')) {
      return response({ success: true, assets: [asset()], agents: [{ id: 'agent-1', title: 'Research agent' }], stats: { total: 1, available: 1, pulls: 0 } })
    }
    if (url === '/api/repository/projects' && init?.method === 'POST') {
      submitted = JSON.parse(String(init.body))
      return response({ success: true, document: { id: 'project-1' } })
    }
    throw new Error(`Unexpected request: ${url}`)
  }) as typeof fetch

  render(<ContentRepository writable />)
  fireEvent.click(await screen.findByRole('button', { name: 'New project' }))
  fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Launch plan' } })
  fireEvent.change(screen.getByLabelText('Project summary'), { target: { value: 'Q4 launch' } })
  fireEvent.change(screen.getByLabelText('Project reference'), { target: { value: 'Owner: Maya\nStatus: active' } })
  fireEvent.change(screen.getByLabelText('Project reference scope'), { target: { value: 'agent-1' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save project' }))

  await waitFor(() => assert.ok(submitted))
  assert.deepEqual(submitted, {
    name: 'Launch plan',
    summary: 'Q4 launch',
    content: 'Owner: Maya\nStatus: active',
    workspaceScope: false,
    agentId: 'agent-1',
  })
})

test('synchronizes a selected private GitHub repository without implicit workspace sharing', async () => {
  let submitted: Record<string, unknown> | null = null
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('/api/repository?')) {
      return response({ success: true, assets: [asset()], agents: [{ id: 'agent-1', title: 'Research agent' }], stats: { total: 1, available: 1, pulls: 0 } })
    }
    if (url === '/api/repository/github/repositories') {
      return response({ success: true, repositories: [{ id: 42, fullName: 'acme/private-docs', owner: 'acme', name: 'private-docs', private: true, defaultBranch: 'main', updatedAt: null, htmlUrl: 'https://github.com/acme/private-docs' }] })
    }
    if (url === '/api/repository/github/sync' && init?.method === 'POST') {
      submitted = JSON.parse(String(init.body))
      return response({ success: true, result: { created: 1, updated: 0, unchanged: 0, failed: 0, skipped: {} } })
    }
    throw new Error(`Unexpected request: ${url}`)
  }) as typeof fetch

  render(<ContentRepository writable />)
  fireEvent.click(await screen.findByRole('button', { name: 'Sync GitHub' }))
  fireEvent.change(await screen.findByLabelText('GitHub repository'), { target: { value: '42' } })
  assert.ok(screen.getByText(/This is a private repository/))
  fireEvent.change(screen.getByLabelText('GitHub directory'), { target: { value: 'docs' } })
  fireEvent.change(screen.getByLabelText('GitHub reference scope'), { target: { value: 'agent-1' } })
  fireEvent.click(screen.getByRole('button', { name: 'Sync repository' }))

  await waitFor(() => assert.ok(submitted))
  assert.deepEqual(submitted, {
    owner: 'acme',
    repo: 'private-docs',
    ref: 'main',
    pathPrefix: 'docs',
    workspaceScope: false,
    agentId: 'agent-1',
    maxFiles: 50,
  })
})

test('an unindexed asset says so instead of reading as ready', async () => {
  globalThis.fetch = (async () => response({
    success: true,
    assets: [asset({ status: 'ready', indexState: 'unindexed', indexError: 'Embedding provider returned 429.' })],
    agents: [],
  })) as typeof fetch

  render(<ContentRepository writable />)

  assert.ok(await screen.findByText('guide.md'))
  assert.ok(screen.getByText(/Not searchable/i))
})

test('a partly indexed asset says only part of it was indexed', async () => {
  globalThis.fetch = (async () => response({
    success: true,
    assets: [asset({ truncated: true, charCount: 200_000 })],
    agents: [],
  })) as typeof fetch

  render(<ContentRepository writable />)

  assert.ok(await screen.findByText('guide.md'))
  assert.ok(screen.getByText(/longer than the indexing limit/i))
})

test('assets show their collections and a collection filter is offered', async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/repository/collections')) {
      return response({ success: true, collections: [{ id: 'c1', name: 'Customer Journey', documentCount: 1, agentCount: 2 }] })
    }
    return response({
      success: true,
      assets: [asset({ collections: [{ id: 'c1', name: 'Customer Journey' }] })],
      agents: [],
    })
  }) as typeof fetch

  render(<ContentRepository writable />)

  assert.ok(await screen.findByText('guide.md'))
  // Renders twice by design: the row badge and the filter option.
  assert.ok((await screen.findAllByText('Customer Journey')).length >= 2)
  assert.ok(screen.getByLabelText(/Filter by collection/i))
})

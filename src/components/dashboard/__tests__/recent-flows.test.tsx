import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen, waitFor } from '@testing-library/react'
import { RecentFlows } from '@/components/dashboard/recent-flows'

const realFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

type StubFlow = { id: string; name: string; icon?: string; updatedAt: string }

/** Stand in for GET /api/flows, which already returns newest-edited first. */
function stubFlows(flows: StubFlow[]) {
  globalThis.fetch = (async () =>
    ({ ok: true, json: async () => ({ success: true, flows }) }) as unknown as Response) as typeof fetch
}

const flow = (id: string, over: Partial<StubFlow> = {}): StubFlow => ({
  id,
  name: `Flow ${id}`,
  updatedAt: new Date().toISOString(),
  ...over,
})

test('each card links into that flow’s canvas', async () => {
  stubFlows([flow('a'), flow('b'), flow('c')])
  render(<RecentFlows />)

  const first = await screen.findByRole('link', { name: /Flow a/ })
  assert.equal(first.getAttribute('href'), '/flows/a')
  assert.equal(screen.getByRole('link', { name: /Flow b/ }).getAttribute('href'), '/flows/b')
  assert.equal(screen.getByRole('link', { name: /Flow c/ }).getAttribute('href'), '/flows/c')
})

test('shows at most three, keeping the API’s newest-first order', async () => {
  stubFlows([flow('a'), flow('b'), flow('c'), flow('d'), flow('e')])
  render(<RecentFlows />)

  await screen.findByText('Flow a')
  assert.equal(screen.queryByText('Flow d'), null)
  assert.equal(screen.queryByText('Flow e'), null)
  assert.equal(screen.getAllByRole('link', { name: /^Flow/ }).length, 3)
})

test('the flow’s emoji stands in for the generic glyph when it has one', async () => {
  stubFlows([flow('a', { icon: '🔮' })])
  render(<RecentFlows />)

  await screen.findByText('Flow a')
  assert.ok(screen.getByText('🔮'))
})

test('a workspace with no flows renders nothing at all', async () => {
  stubFlows([])
  const { container } = render(<RecentFlows />)

  await waitFor(() => assert.equal(container.textContent, ''))
})

test('a failed fetch degrades to nothing, not an error state', async () => {
  globalThis.fetch = (async () => {
    throw new Error('offline')
  }) as typeof fetch
  const { container } = render(<RecentFlows />)

  await waitFor(() => assert.equal(container.textContent, ''))
})

test('a non-OK response degrades to nothing', async () => {
  globalThis.fetch = (async () => ({ ok: false, json: async () => ({}) }) as unknown as Response) as typeof fetch
  const { container } = render(<RecentFlows />)

  await waitFor(() => assert.equal(container.textContent, ''))
})

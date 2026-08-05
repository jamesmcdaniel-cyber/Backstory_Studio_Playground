import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { ProposalInbox } from '../proposal-inbox'

const proposal = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  title: 'Weekly pipeline digest',
  rationale: 'Your team runs this by hand every Monday.',
  kind: 'agent_template',
  status: 'open',
  ...over,
})

function stubFetch(routes: Record<string, (init?: RequestInit) => unknown>) {
  const calls: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const key = String(url)
    calls.push(`${init?.method ?? 'GET'} ${key}`)
    const match = Object.entries(routes).find(([route]) => key.includes(route))
    const body = match ? match[1](init) : { success: false }
    return { ok: true, json: async () => body }
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = realFetch } }
}

test('renders open proposals and accepting posts to the accept route, removing the card', async () => {
  const stub = stubFetch({
    '/accept': () => ({ status: 'accepted', kind: 'agent', templateId: 't1', agentId: 'a1' }),
    '/api/template-proposals': () => ({ success: true, proposals: [proposal()] }),
  })
  try {
    const { findByText, getByText, queryByText } = render(React.createElement(ProposalInbox, { generating: true }))
    await findByText('Weekly pipeline digest')
    fireEvent.click(getByText('Accept'))
    await waitFor(() => assert.equal(queryByText('Weekly pipeline digest'), null))
    assert.ok(stub.calls.some((c) => c.startsWith('POST') && c.includes('/api/template-proposals/p1/accept')))
  } finally {
    stub.restore()
    cleanup()
  }
})

test('dismissing removes the card via the dismiss endpoint', async () => {
  const stub = stubFetch({
    '/dismiss': () => ({ status: 'dismissed' }),
    '/api/template-proposals': () => ({ success: true, proposals: [proposal({ id: 'p2', title: 'Deal risk watcher' })] }),
  })
  try {
    const { findByText, getByText, queryByText } = render(React.createElement(ProposalInbox, { generating: false }))
    await findByText('Deal risk watcher')
    fireEvent.click(getByText('Dismiss'))
    await waitFor(() => assert.equal(queryByText('Deal risk watcher'), null))
    assert.ok(stub.calls.some((c) => c.startsWith('POST') && c.includes('/api/template-proposals/p2/dismiss')))
  } finally {
    stub.restore()
    cleanup()
  }
})

test('empty inbox copy tracks whether generation is still running', async () => {
  const stub = stubFetch({ '/api/template-proposals': () => ({ success: true, proposals: [] }) })
  try {
    const learning = render(React.createElement(ProposalInbox, { generating: true }))
    await learning.findByText(/still learning/i)
    cleanup()
    const settled = render(React.createElement(ProposalInbox, { generating: false }))
    await settled.findByText(/build your own anytime/i)
  } finally {
    stub.restore()
    cleanup()
  }
})

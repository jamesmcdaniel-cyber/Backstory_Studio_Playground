import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { render, cleanup, screen } from '@testing-library/react'
import ApprovalsPage from '../page'

const flush = async () => {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

const base = { tool: 'update_record', status: 'pending', createdAt: new Date().toISOString(), executionId: 'run_1', source: { kind: 'flow', flowId: 'f1', flowName: 'CRM updates' } }
const APPROVALS = [
  // Newest first, as the API returns them — the page orders a run's items.
  { ...base, id: 'a2', summary: 'update_record for item 2 of 3 · Globex (crm)', item: { index: 1, count: 3, label: 'Globex' } },
  { ...base, id: 'a1', summary: 'update_record for item 1 of 3 · Acme (crm)', item: { index: 0, count: 3, label: 'Acme' } },
  { ...base, id: 'solo', executionId: 'exec_9', summary: 'slack_post_message (slack)', tool: 'slack_post_message', item: null, source: { kind: 'agent', agentId: 'ag1' } },
]

function stub(posts: Array<{ url: string; body: any }>) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      posts.push({ url: String(url), body })
      return { ok: true, json: async () => ({ success: true, results: body.ids.map((id: string) => ({ id, status: 'approved', executed: true })) }) }
    }
    return { ok: true, json: async () => ({ success: true, approvals: posts.length ? [APPROVALS[2]] : APPROVALS, hasMore: false }) }
  }) as unknown as typeof fetch
}

test('a run\'s per-item approvals are grouped under the flow, each naming its item', async () => {
  stub([])
  render(<ApprovalsPage />)
  await flush()
  assert.ok(screen.getByText('CRM updates'), 'the run is headed by its flow')
  const items = screen.getAllByText(/^Item \d of 3: /).map((node) => node.textContent)
  assert.deepEqual(items, ['Item 1 of 3: Acme', 'Item 2 of 3: Globex'], 'items in order, each named')
  assert.ok(screen.getByRole('button', { name: 'Approve Item 1 of 3: Acme' }), 'per-item buttons say which item')
  assert.ok(screen.getByText(/2 of 2 items waiting/))
  cleanup()
})

test('approve all sends the run\'s pending approvals in one batch', async () => {
  const posts: Array<{ url: string; body: any }> = []
  stub(posts)
  render(<ApprovalsPage />)
  await flush()
  await act(async () => {
    screen.getByRole('button', { name: /^approve all$/i }).click()
    await Promise.resolve()
  })
  await flush()
  assert.equal(posts.length, 1)
  assert.equal(posts[0].url, '/api/approvals/batch')
  assert.deepEqual(posts[0].body, { ids: ['a1', 'a2'], decision: 'approve' }, 'only that run, never the unrelated approval')
  assert.equal(screen.queryByRole('button', { name: /^reject all$/i }), null, 'the batch is gone once decided')
  cleanup()
})

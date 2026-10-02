import '@/test-support/jsdom-env'
import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import { SharedTemplateCopilot } from '../shared-template-copilot'

// jsdom has no layout, so no scrollIntoView.
HTMLElement.prototype.scrollIntoView = () => {}

type Call = { url: string; method?: string; body?: string }

function stubFetch(handler: (call: Call) => Response) {
  const original = globalThis.fetch
  const calls: Call[] = []
  globalThis.fetch = async (url, init) => {
    const call = { url: String(url), method: init?.method, body: typeof init?.body === 'string' ? init.body : undefined }
    calls.push(call)
    return handler(call)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

const copy = (chat: unknown[] = [], version = 1) => ({
  id: 'copy-1', kind: 'page', title: 'Cockpit · my copy', agent: { id: 'agent-1', title: 'AI Copilot' }, flow: null,
  currentVersionId: `v${version}`, versionCount: version, versions: [{ id: `v${version}`, number: version, format: 'html' }], chat,
  interactive: true, build: null, archivedAt: null, permissions: { canEdit: true, canShare: false, canConfigure: false, reason: 'owner' },
  configurationLocked: true, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
})
const guest = (chat: unknown[] = [], versionId = 'gv1') => ({ copyId: 'guest-copy', title: 'Cockpit · visitor copy', versionId, edited: versionId !== 'gv1', chat })

test('viewing a template never creates a copy; an explicit click POSTs and failures are recoverable', async () => {
  const net = stubFetch(() => Response.json({ error: 'Template no longer shared' }, { status: 404 }))
  try {
    const ui = render(<SharedTemplateCopilot token="test-token"><p>original</p></SharedTemplateCopilot>)
    assert.equal(net.calls.length, 0)
    assert.ok(ui.getByText('original'))
    await act(async () => { fireEvent.click(ui.getByRole('button', { name: 'AI Copilot' })) })
    assert.deepEqual(net.calls.map(({ url, method }) => ({ url, method })), [{ url: '/api/share/artifacts/test-token/copy', method: 'POST' }])
    assert.match(ui.getByRole('alert').textContent ?? '', /Template no longer shared/)
    await act(async () => { fireEvent.click(ui.getByRole('button', { name: 'Try again' })) })
    assert.equal(net.calls.length, 2)
  } finally { cleanup(); net.restore() }
})

test('a visitor with no account is never sent to sign in: the copilot opens a guest copy on the page', async () => {
  const net = stubFetch((call) => {
    if (call.url.endsWith('/copy')) return Response.json({ error: 'Unauthorized' }, { status: 401 })
    if (call.method === 'POST' && JSON.parse(call.body ?? '{}').action === 'ask') return Response.json({ success: true, copilot: guest([{ role: 'user', content: 'Make it blue', createdAt: 'a' }, { role: 'agent', content: 'Done — it is blue.', status: 'completed', createdAt: 'b' }], 'gv2') })
    return Response.json({ success: true, copilot: guest() })
  })
  try {
    const ui = render(<SharedTemplateCopilot token="test-token"><p>original</p></SharedTemplateCopilot>)
    await act(async () => { fireEvent.click(ui.getByRole('button', { name: 'AI Copilot' })) })
    // Exactly these two requests: the guest copy opens here, with no trip to sign in.
    assert.deepEqual(net.calls.map(({ url, method, body }) => ({ url, method, body })), [
      { url: '/api/share/artifacts/test-token/copy', method: 'POST', body: undefined },
      { url: '/api/share/artifacts/test-token/copilot', method: 'POST', body: '{"action":"open"}' },
    ])
    // Opening the copilot changes nothing on screen: no second page for "the copy".
    assert.ok(ui.getByText('original'))
    assert.equal(ui.container.querySelector('iframe'), null)
    assert.equal(ui.container.querySelector('a[href^="/artifacts/"]'), null, 'nothing links out to a separate copy page')
    await act(async () => { fireEvent.change(ui.getByRole('textbox', { name: 'Message' }), { target: { value: 'Make it blue' } }) })
    await act(async () => { fireEvent.click(ui.getByRole('button', { name: 'Send message' })) })
    assert.deepEqual(JSON.parse(net.calls.at(-1)?.body ?? '{}'), { action: 'ask', message: 'Make it blue' })
    assert.ok(ui.getByText('Done — it is blue.'))
    assert.equal(ui.queryByText('original'), null)
    assert.equal(ui.container.querySelector('iframe')?.getAttribute('src'), '/api/share/artifacts/test-token/copilot/content?copy=guest-copy&v=gv2', 'the change appears in place')
  } finally { cleanup(); net.restore() }
})

test('a returning visitor sees the copy they already changed, with the panel closed', async () => {
  const net = stubFetch(() => Response.json({ success: true, copilot: guest([], 'gv3') }))
  try {
    const ui = render(<SharedTemplateCopilot token="test-token" returning><p>original</p></SharedTemplateCopilot>)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    assert.deepEqual(net.calls.map(({ url, method }) => ({ url, method })), [{ url: '/api/share/artifacts/test-token/copilot', method: undefined }])
    assert.equal(ui.container.querySelector('iframe')?.getAttribute('src'), '/api/share/artifacts/test-token/copilot/content?copy=guest-copy&v=gv3')
    assert.equal(ui.queryByRole('dialog'), null)
  } finally { cleanup(); net.restore() }
})

test('someone signed in works in a copy in their own workspace, without leaving the shared page', async () => {
  const net = stubFetch((call) => {
    if (call.url.endsWith('/copy')) return Response.json({ success: true, artifactId: 'copy-1' })
    if (call.url.endsWith('/chat')) return Response.json({ success: true, artifact: copy([{ role: 'user', content: 'Make it blue', createdAt: 'a' }, { role: 'agent', content: 'Done — it is blue.', status: 'completed', createdAt: 'b' }], 2) })
    return Response.json({ success: true, artifact: copy() })
  })
  try {
    const ui = render(<SharedTemplateCopilot token="test-token"><p>original</p></SharedTemplateCopilot>)
    await act(async () => { fireEvent.click(ui.getByRole('button', { name: 'AI Copilot' })) })
    assert.ok(ui.getByRole('dialog', { name: 'AI Copilot' }))
    assert.ok(ui.getByText('original'), 'the page stays as it is until there is a change to show')
    assert.equal(ui.container.querySelector('a[href^="/artifacts/"]'), null, 'nothing links out to a separate copy page')
    await act(async () => { fireEvent.change(ui.getByRole('textbox', { name: 'Message' }), { target: { value: 'Make it blue' } }) })
    await act(async () => { fireEvent.click(ui.getByRole('button', { name: 'Send message' })) })
    const chat = net.calls.find((call) => call.url === '/api/artifacts/copy-1/chat')
    assert.equal(chat?.method, 'POST')
    assert.deepEqual(JSON.parse(chat?.body ?? '{}'), { message: 'Make it blue', mode: 'auto' })
    assert.ok(ui.getByText('Done — it is blue.'))
    assert.equal(ui.container.querySelector('iframe')?.getAttribute('src'), '/api/artifacts/copy-1/versions/v2/content', 'the change appears in place')
  } finally { cleanup(); net.restore() }
})

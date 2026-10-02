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

const copy = (chat: unknown[] = []) => ({
  id: 'copy-1', kind: 'page', title: 'Cockpit · my copy', agent: { id: 'agent-1', title: 'AI Copilot' }, flow: null,
  currentVersionId: 'v1', versionCount: 1, versions: [{ id: 'v1', number: 1, format: 'html' }], chat,
  interactive: true, build: null, archivedAt: null, permissions: { canEdit: true, canShare: false, canConfigure: false, reason: 'owner' },
  configurationLocked: true, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
})

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

test('the copilot opens on the shared page: the copy replaces the original and messages go to its assistant', async () => {
  const net = stubFetch((call) => {
    if (call.url.endsWith('/copy')) return Response.json({ success: true, artifactId: 'copy-1' })
    if (call.url.endsWith('/chat')) return Response.json({ success: true, artifact: copy([{ role: 'user', content: 'Make it blue', createdAt: 'a' }, { role: 'agent', content: 'Done — it is blue.', status: 'completed', createdAt: 'b' }]) })
    return Response.json({ success: true, artifact: copy() })
  })
  try {
    const ui = render(<SharedTemplateCopilot token="test-token"><p>original</p></SharedTemplateCopilot>)
    await act(async () => { fireEvent.click(ui.getByRole('button', { name: 'AI Copilot' })) })
    assert.ok(ui.getByRole('dialog', { name: 'AI Copilot' }))
    // Stayed here: the frame now shows the visitor's copy, not the original.
    assert.equal(ui.queryByText('original'), null)
    assert.equal(ui.container.querySelector('iframe')?.getAttribute('src'), '/api/artifacts/copy-1/versions/v1/content')
    const input = ui.getByLabelText('Message') as HTMLTextAreaElement
    await act(async () => { fireEvent.change(input, { target: { value: 'Make it blue' } }) })
    await act(async () => { fireEvent.click(ui.getByRole('button', { name: 'Send message' })) })
    const chat = net.calls.find((call) => call.url === '/api/artifacts/copy-1/chat')
    assert.equal(chat?.method, 'POST')
    assert.deepEqual(JSON.parse(chat?.body ?? '{}'), { message: 'Make it blue', mode: 'auto' })
    assert.ok(ui.getByText('Done — it is blue.'))
  } finally { cleanup(); net.restore() }
})

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
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    // Loading only LOOKS for a copy they already have (a read); nothing is made.
    assert.deepEqual(net.calls.map(({ url, method }) => ({ url, method })), [{ url: '/api/share/artifacts/test-token/copy', method: undefined }])
    assert.ok(ui.getByText('original'))
    await act(async () => { fireEvent.click(ui.getByRole('button', { name: 'AI Copilot' })) })
    assert.deepEqual(net.calls.slice(1).map(({ url, method }) => ({ url, method })), [{ url: '/api/share/artifacts/test-token/copy', method: 'POST' }])
    assert.match(ui.getByRole('alert').textContent ?? '', /Template no longer shared/)
    await act(async () => { fireEvent.click(ui.getByRole('button', { name: 'Try again' })) })
    assert.equal(net.calls.length, 3)
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
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    await act(async () => { fireEvent.click(ui.getByRole('button', { name: 'AI Copilot' })) })
    // Exactly these two requests after the load-time lookup: the guest copy opens here, with no trip to sign in.
    assert.deepEqual(net.calls.slice(1).map(({ url, method, body }) => ({ url, method, body })), [
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
  const net = stubFetch((call) => call.url.endsWith('/copy') ? Response.json({ error: 'Unauthorized' }, { status: 401 }) : Response.json({ success: true, copilot: guest([], 'gv3') }))
  try {
    const ui = render(<SharedTemplateCopilot token="test-token" returning><p>original</p></SharedTemplateCopilot>)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    assert.deepEqual(net.calls.map(({ url, method }) => ({ url, method })), [{ url: '/api/share/artifacts/test-token/copy', method: undefined }, { url: '/api/share/artifacts/test-token/copilot', method: undefined }])
    assert.equal(ui.container.querySelector('iframe')?.getAttribute('src'), '/api/share/artifacts/test-token/copilot/content?copy=guest-copy&v=gv3')
    assert.equal(ui.queryByRole('dialog'), null)
  } finally { cleanup(); net.restore() }
})

test('a visitor can look back through their copy’s versions and restore one, without an account', async () => {
  const history = (latest: number) => Array.from({ length: latest }, (_, index) => ({ id: `gv${latest - index}`, number: latest - index, request: latest - index === 1 ? null : `Change ${latest - index}`, createdAt: '2026-10-02T00:00:00Z', source: latest - index === 1 ? 'created' : 'agent' }))
  const net = stubFetch((call) => {
    if (call.url.endsWith('/copy')) return Response.json({ error: 'Unauthorized' }, { status: 401 })
    if (call.method === 'POST' && JSON.parse(call.body ?? '{}').action === 'restore') return Response.json({ success: true, copilot: { ...guest([], 'gv4'), versions: history(4) } })
    return Response.json({ success: true, copilot: { ...guest([], 'gv3'), versions: history(3) } })
  })
  const frame = (ui: ReturnType<typeof render>) => ui.container.querySelector('iframe')?.getAttribute('src')?.split('&v=')[1]
  try {
    const ui = render(<SharedTemplateCopilot token="test-token" returning><p>original</p></SharedTemplateCopilot>)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    assert.equal(frame(ui), 'gv3')
    await act(async () => { fireEvent.click(ui.getByRole('button', { name: 'AI Copilot' })) })
    await act(async () => { fireEvent.click(ui.getByRole('tab', { name: /History \(3\)/ })) })
    const rows = ui.getByRole('list', { name: 'Version history' }).querySelectorAll('li')
    assert.equal(rows.length, 3)
    // Looking at an older version is only a view: the latest is one click back.
    await act(async () => { fireEvent.click(rows[1].querySelector('button')!) })
    assert.equal(frame(ui), 'gv2')
    assert.match(ui.getByRole('status').textContent ?? '', /Viewing version 2/)
    await act(async () => { fireEvent.click(ui.getByRole('button', { name: 'Back to latest' })) })
    assert.equal(frame(ui), 'gv3')
    // Restoring puts it back as a new version on top; the history is kept.
    await act(async () => { fireEvent.click(ui.getAllByRole('button', { name: 'Restore' })[0]) })
    assert.deepEqual(JSON.parse(net.calls.at(-1)?.body ?? '{}'), { action: 'restore', versionId: 'gv2' })
    assert.equal(frame(ui), 'gv4')
    assert.ok(ui.getByRole('tab', { name: /History \(4\)/ }))
  } finally { cleanup(); net.restore() }
})

test('a copy the server already resolved is on screen from the first paint — the original never flashes, and nothing is looked up', async () => {
  const net = stubFetch(() => Response.json({ error: 'unexpected' }, { status: 500 }))
  try {
    const asGuest = render(<SharedTemplateCopilot token="test-token" initialCopy={{ kind: 'guest', view: { ...guest([], 'gv3'), versions: [] } as never }}><p>original</p></SharedTemplateCopilot>)
    // Synchronously, before any effect or fetch: this is what the server sends.
    assert.equal(asGuest.queryByText('original'), null)
    assert.equal(asGuest.container.querySelector('iframe')?.getAttribute('src'), '/api/share/artifacts/test-token/copilot/content?copy=guest-copy&v=gv3')
    cleanup()
    const asMember = render(<SharedTemplateCopilot token="test-token" initialCopy={{ kind: 'member', id: 'copy-1', artifact: copy([], 3) as never }}><p>original</p></SharedTemplateCopilot>)
    assert.equal(asMember.queryByText('original'), null)
    cleanup()
    // No copy yet: the original, and still no lookup — the server already looked.
    const none = render(<SharedTemplateCopilot token="test-token" initialCopy={null}><p>original</p></SharedTemplateCopilot>)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    assert.ok(none.getByText('original'))
    assert.equal(net.calls.filter((call) => !call.url.includes('/state') && !call.url.includes('/versions/')).length, 0)
  } finally { cleanup(); net.restore() }
})

test('the copilot’s Settings connect a visitor’s own MCP server with their own credential, and remove it', async () => {
  const connected = [{ id: 'srv-1', name: 'mcp.example.com', serverUrl: 'https://mcp.example.com/mcp', authType: 'api_key', toolCount: 4 }]
  const net = stubFetch((call) => {
    if (call.url.endsWith('/copy')) return Response.json({ error: 'Unauthorized' }, { status: 401 })
    const action = call.method === 'POST' ? JSON.parse(call.body ?? '{}').action : null
    if (action === 'mcp_add') return Response.json({ success: true, copilot: { ...guest(), mcpServers: connected } })
    return Response.json({ success: true, copilot: { ...guest(), mcpServers: [] } })
  })
  try {
    const ui = render(<SharedTemplateCopilot token="test-token"><p>original</p></SharedTemplateCopilot>)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    await act(async () => { fireEvent.click(ui.getByRole('button', { name: 'AI Copilot' })) })
    await act(async () => { fireEvent.click(ui.getByRole('tab', { name: 'Settings' })) })
    assert.ok(ui.getByText(/using the demo data this link came with/))
    await act(async () => { fireEvent.change(ui.getByLabelText('Server address'), { target: { value: 'https://mcp.example.com/mcp' } }) })
    await act(async () => { fireEvent.change(ui.getByLabelText('API key or token'), { target: { value: 'my-token' } }) })
    await act(async () => { fireEvent.click(ui.getByRole('button', { name: 'Connect' })) })
    assert.deepEqual(JSON.parse(net.calls.at(-1)?.body ?? '{}'), { action: 'mcp_add', server: { serverUrl: 'https://mcp.example.com/mcp', authType: 'api_key', apiKey: 'my-token' } })
    assert.ok(ui.getByText('API key or token · 4 tools'))
    assert.equal((ui.getByLabelText('API key or token') as HTMLInputElement).value, '', 'the credential is not kept on screen')
    await act(async () => { fireEvent.click(ui.getByRole('button', { name: 'Remove mcp.example.com' })) })
    assert.deepEqual(JSON.parse(net.calls.at(-1)?.body ?? '{}'), { action: 'mcp_remove', serverId: 'srv-1' })
    assert.ok(ui.getByText(/using the demo data this link came with/))
  } finally { cleanup(); net.restore() }
})

test('someone signed in who comes back sees their copy’s latest version without opening the copilot', async () => {
  const net = stubFetch((call) => call.url.endsWith('/copy') ? Response.json({ success: true, artifactId: 'copy-1' }) : Response.json({ success: true, artifact: copy([], 3) }))
  try {
    const ui = render(<SharedTemplateCopilot token="test-token"><p>original</p></SharedTemplateCopilot>)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    assert.ok(net.calls.every((call) => call.method !== 'POST'), 'looking for the copy never creates one')
    assert.equal(ui.queryByText('original'), null)
    assert.equal(ui.container.querySelector('iframe')?.getAttribute('src'), '/api/artifacts/copy-1/versions/v3/content')
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

test('“Open in Runs” is offered only to the person who owns the copy’s agent — never to an anonymous visitor', async () => {
  const pendingChat = [{ role: 'user', content: 'Make it blue', createdAt: 'a' }, { role: 'agent', content: '', executionId: 'run-1', status: 'pending', createdAt: 'a' }]
  const open = async (handler: (call: Call) => Response) => {
    const net = stubFetch(handler)
    const ui = render(<SharedTemplateCopilot token="test-token"><p>original</p></SharedTemplateCopilot>)
    await act(async () => { fireEvent.click(ui.getByRole('button', { name: 'AI Copilot' })) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const link = ui.container.querySelector('a[href^="/agents?run="]')
    cleanup(); net.restore()
    return link
  }
  const member = (permissions: object) => (call: Call) => call.url.endsWith('/copy') ? Response.json({ success: true, artifactId: 'copy-1' })
    // The run log (and its link) shows once the run does real work — here, a data lookup.
    : call.url.startsWith('/api/workflows') ? Response.json({ items: [{ execution: { id: 'run-1', status: 'running' }, steps: [{ id: 's1', node: 'backstory.find_account', status: 'running' }], events: [] }] })
    : Response.json({ success: true, artifact: { ...copy(pendingChat), permissions } })
  assert.ok(await open(member({ canEdit: true, canShare: false, reason: 'owner' })), 'the copy’s owner can open its run')
  assert.equal(await open(member({ canEdit: false, canShare: false, reason: 'view_only' })), null)
  assert.equal(await open((call) => call.url.endsWith('/copy') ? Response.json({ error: 'Unauthorized' }, { status: 401 }) : Response.json({ success: true, copilot: guest(pendingChat) })), null, 'an anonymous visitor never sees it')
})

test('the page reloads once, when the copilot has finished — not at every save along the way', async () => {
  const asked = [{ role: 'user', content: 'Rework it', createdAt: 'a' }]
  let polls = 0
  const net = stubFetch((call) => {
    if (call.url.endsWith('/copy')) return Response.json({ error: 'Unauthorized' }, { status: 401 })
    if (call.method === 'POST') return Response.json({ success: true, copilot: guest([...asked, { role: 'agent', content: '', status: 'pending', createdAt: 'a' }], 'gv3') })
    polls += 1
    // First read: the visitor's edited copy. Later reads: the run saving again, then finishing.
    if (polls === 1) return Response.json({ success: true, copilot: guest([], 'gv2') })
    return Response.json({ success: true, copilot: guest([...asked, { role: 'agent', content: 'Done.', status: 'completed', createdAt: 'b' }], 'gv5') })
  })
  const frame = (ui: ReturnType<typeof render>) => ui.container.querySelector('iframe')?.getAttribute('src')?.split('&v=')[1]
  try {
    const ui = render(<SharedTemplateCopilot token="test-token" returning><p>original</p></SharedTemplateCopilot>)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    assert.equal(frame(ui), 'gv2')
    await act(async () => { fireEvent.click(ui.getByRole('button', { name: 'AI Copilot' })) })
    await act(async () => { fireEvent.change(ui.getByRole('textbox', { name: 'Message' }), { target: { value: 'Rework it' } }) })
    await act(async () => { fireEvent.click(ui.getByRole('button', { name: 'Send message' })) })
    assert.equal(frame(ui), 'gv2', 'a version saved mid-run does not reload the page')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3_300)) })
    assert.ok(ui.getByText('Done.'))
    assert.equal(frame(ui), 'gv5', 'the finished result appears, in one step')
  } finally { cleanup(); net.restore() }
})

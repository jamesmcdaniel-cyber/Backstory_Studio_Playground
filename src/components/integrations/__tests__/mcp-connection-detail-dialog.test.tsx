import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { McpConnectionDetailDialog, mcpConnectionBroken } from '../mcp-connection-detail-dialog'
import type { SerializedConnection } from '@/app/connections/mcp-connection-dialog'

const connection: SerializedConnection = {
  id: 'mcp-1',
  name: 'Backstory MCP Demo',
  description: 'Sales AI over the Keyslogic demo tenant.',
  serverUrl: 'https://mcp.people.ai/mcp',
  isActive: true,
  lastVerifiedAt: '2026-10-20T10:00:00.000Z',
  healthStatus: 'healthy',
  auth: { authType: 'oauth2', flow: 'authcode' },
}

const toolsResponse = {
  success: true,
  connection: {
    id: 'mcp-1', name: 'Backstory MCP Demo', description: 'Sales AI over the Keyslogic demo tenant.', provider: null,
    serverUrl: 'https://mcp.people.ai/mcp', isActive: true, healthStatus: 'healthy', lastError: null,
    lastVerifiedAt: '2026-10-20T10:00:00.000Z', needsSignIn: true, canManage: true, canEdit: true,
  },
  items: [
    { name: 'account_company_news', title: 'Account company news', description: 'Recent news for an account', readOnly: true, policy: 'allow' },
    { name: 'find_account', title: 'Find account', description: '', readOnly: true, policy: 'approve' },
    { name: 'update_record', title: 'Update record', description: 'Change a CRM record', readOnly: false, destructive: true, policy: 'off' },
  ],
}

type Call = { url: string; method: string; body?: unknown }

/** A fetch stub: routes are "METHOD /url-prefix"; every call is recorded. */
function stubFetch(routes: Record<string, (call: Call) => { status?: number; body: unknown }>) {
  const calls: Call[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const call: Call = { url, method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) }
    calls.push(call)
    const key = Object.keys(routes).find((route) => {
      const [method, prefix] = route.split(' ')
      return method === call.method && url.startsWith(prefix)
    })
    const result = key ? routes[key](call) : { status: 404, body: { error: 'not stubbed' } }
    return new Response(JSON.stringify(result.body), { status: result.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

function open(overrides: Partial<Parameters<typeof McpConnectionDetailDialog>[0]> = {}) {
  return render(
    <McpConnectionDetailDialog
      connection={connection}
      returnTo="/integrations?tab=servers"
      verifying={false}
      onVerify={() => {}}
      onEdit={() => {}}
      onDisconnect={async () => {}}
      onClose={() => {}}
      {...overrides}
    />,
  )
}

const row = (title: string) => screen.getByRole('radiogroup', { name: `When ${title} may run` })
const checked = (title: string) => within(row(title)).getAllByRole('radio').find((radio) => radio.getAttribute('aria-checked') === 'true')?.getAttribute('aria-label')

test('lists every tool by its readable name, grouped by what the server says it does, with its permission', async (t) => {
  const fetchStub = stubFetch({ 'GET /api/mcp-connections/mcp-1/tools': () => ({ body: toolsResponse }) })
  t.after(() => { cleanup(); fetchStub.restore() })
  open()
  await screen.findByText('Account company news')
  assert.ok(screen.getByRole('heading', { name: 'Backstory MCP Demo' }))
  assert.ok(screen.getByText('Connected'))
  assert.ok(screen.getByRole('button', { name: /Read-only tools\s*2/ }))
  assert.ok(screen.getByRole('button', { name: /Write tools\s*1/ }))
  assert.equal(checked('Account company news'), 'Always allow')
  assert.equal(checked('Find account'), 'Needs approval')
  assert.equal(checked('Update record'), 'Blocked')
  assert.equal(fetchStub.calls[0].url, '/api/mcp-connections/mcp-1/tools?all=1')
})

test('choosing a permission saves it at once and shows it before the server answers', async (t) => {
  const fetchStub = stubFetch({
    'GET /api/mcp-connections/mcp-1/tools': () => ({ body: toolsResponse }),
    'PATCH /api/mcp-connections/mcp-1/tools': () => ({ body: { success: true } }),
  })
  t.after(() => { cleanup(); fetchStub.restore() })
  const changed: string[] = []
  open({ onPermissionsChanged: () => changed.push('changed') })
  await screen.findByText('Account company news')
  fireEvent.click(within(row('Account company news')).getByRole('radio', { name: 'Blocked' }))
  assert.equal(checked('Account company news'), 'Blocked', 'optimistic')
  await waitFor(() => assert.equal(changed.length, 1))
  const patch = fetchStub.calls.find((call) => call.method === 'PATCH')
  assert.deepEqual(patch?.body, { tools: { account_company_news: 'off' } })
})

test('a refused save puts the permission back', async (t) => {
  const fetchStub = stubFetch({
    'GET /api/mcp-connections/mcp-1/tools': () => ({ body: toolsResponse }),
    'PATCH /api/mcp-connections/mcp-1/tools': () => ({ status: 403, body: { error: 'Only a workspace admin can change the tools of a shared server.' } }),
  })
  t.after(() => { cleanup(); fetchStub.restore() })
  open()
  await screen.findByText('Find account')
  fireEvent.click(within(row('Find account')).getByRole('radio', { name: 'Always allow' }))
  assert.equal(checked('Find account'), 'Always allow')
  await waitFor(() => assert.equal(checked('Find account'), 'Needs approval'))
})

test('arrow keys move the permission within a row', async (t) => {
  const fetchStub = stubFetch({
    'GET /api/mcp-connections/mcp-1/tools': () => ({ body: toolsResponse }),
    'PATCH /api/mcp-connections/mcp-1/tools': () => ({ body: { success: true } }),
  })
  t.after(() => { cleanup(); fetchStub.restore() })
  open()
  await screen.findByText('Account company news')
  const current = within(row('Account company news')).getByRole('radio', { name: 'Always allow' })
  assert.equal(current.tabIndex, 0, 'one tab stop per row: the chosen option')
  fireEvent.keyDown(current, { key: 'ArrowRight' })
  assert.equal(checked('Account company news'), 'Needs approval')
  await waitFor(() => assert.ok(fetchStub.calls.some((call) => call.method === 'PATCH')))
})

test('Disconnect asks first and names what depends on the server', async (t) => {
  const fetchStub = stubFetch({
    'GET /api/mcp-connections/mcp-1/tools': () => ({ body: toolsResponse }),
    'GET /api/credentials/dependents': () => ({
      body: { success: true, summary: '1 published flow and 1 agent use this credential.', dependents: [
        { type: 'flow', id: 'f1', name: 'Weekly pipeline digest', published: true },
        { type: 'agent', id: 'a1', name: 'Deal coach' },
      ] },
    }),
  })
  t.after(() => { cleanup(); fetchStub.restore() })
  let disconnected = 0
  let closed = 0
  open({ onDisconnect: async () => { disconnected += 1 }, onClose: () => { closed += 1 } })
  await screen.findByText('Account company news')
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
  await screen.findByText('Weekly pipeline digest')
  assert.ok(screen.getByText('Deal coach'))
  assert.equal(disconnected, 0, 'nothing happens until it is confirmed')
  const confirmDialog = screen.getByRole('dialog', { name: 'Disconnect Backstory MCP Demo?' })
  await act(async () => { fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Disconnect' })) })
  await waitFor(() => assert.equal(disconnected, 1))
  assert.equal(closed, 1)
  assert.ok(fetchStub.calls.some((call) => call.url === '/api/credentials/dependents?kind=mcp_connection&ref=mcp-1'))
})

test('tools that fail to load offer Reconnect instead of an empty list', async (t) => {
  const fetchStub = stubFetch({
    'GET /api/mcp-connections/mcp-1/tools': () => ({ body: { success: false, error: "Couldn't load this connection's actions — reconnect it and try again.", connection: { ...toolsResponse.connection, needsSignIn: false }, items: [] } }),
  })
  t.after(() => { cleanup(); fetchStub.restore() })
  let verified = 0
  open({ onVerify: () => { verified += 1 } })
  await screen.findByText(/Couldn't load this connection's actions/)
  assert.equal(screen.queryByRole('radiogroup'), null)
  fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
  assert.equal(verified, 1, 'a server with no sign-in behind it is re-verified')
})

test('a person who cannot manage a shared server sees its permissions read-only and no Disconnect', async (t) => {
  const fetchStub = stubFetch({
    'GET /api/mcp-connections/mcp-1/tools': () => ({ body: { ...toolsResponse, connection: { ...toolsResponse.connection, canManage: false, canEdit: false } } }),
  })
  t.after(() => { cleanup(); fetchStub.restore() })
  open()
  await screen.findByText('Account company news')
  assert.ok(screen.getByText(/Only a workspace admin can change/))
  assert.equal((within(row('Account company news')).getByRole('radio', { name: 'Blocked' }) as HTMLButtonElement).disabled, true)
  assert.equal(screen.queryByRole('button', { name: 'Disconnect' }), null)
})

test('a server is "connected" only when it is on, verified and answering', () => {
  assert.equal(mcpConnectionBroken(connection), false)
  assert.equal(mcpConnectionBroken({ ...connection, isActive: false }), true)
  assert.equal(mcpConnectionBroken({ ...connection, lastVerifiedAt: null }), true)
  assert.equal(mcpConnectionBroken({ ...connection, healthStatus: 'unhealthy' }), true)
  assert.equal(mcpConnectionBroken({ ...connection, healthStatus: 'schema_changed' }), false, 'new tools are not a broken connection')
})

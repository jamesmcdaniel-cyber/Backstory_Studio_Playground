import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EMBED_CONNECT_DONE_MESSAGE, topLevelNavigation } from '@/lib/embed'
import { useEmbeddedOAuth } from '@/hooks/use-embedded-oauth'
import { EmbeddedOAuthStatus } from '@/components/auth/embedded-oauth-status'
import { McpConnectionDetailDialog } from '../mcp-connection-detail-dialog'
import { WorkspaceCredentialsPanel } from '../workspace-credentials-panel'
import { McpConnectionDialog, type SerializedConnection } from '@/app/connections/mcp-connection-dialog'
import { reconnectHref } from '@/lib/mcp/reconnect'

/**
 * Every OAuth control the embedded (Salesforce-framed) app can reach: framed,
 * the flow opens in a popup and the frame never navigates; top-level, the
 * control redirects exactly as it always did. The regression this pins is the
 * frame being sent to an identity provider that refuses to be framed, with a
 * SameSite=Lax state cookie the frame never stores.
 */

// ── harness ───────────────────────────────────────────────────────────────

const realSelf = window.self
/** isEmbedded() compares window.self to window.top; only `self` is redefinable. */
function setFramed(framed: boolean) {
  Object.defineProperty(window, 'self', { value: framed ? ({} as Window) : realSelf, configurable: true, writable: true })
}

type OpenCall = { url: string; name: string }
function stubWindowOpen(result: Window | null = {} as Window): OpenCall[] {
  const calls: OpenCall[] = []
  ;(window as unknown as Record<string, unknown>).open = (url: string, name: string) => {
    calls.push({ url, name })
    return result
  }
  return calls
}

function stubNavigation(): string[] {
  const calls: string[] = []
  const original = topLevelNavigation.assign
  topLevelNavigation.assign = (href: string) => { calls.push(href) }
  navRestores.push(() => { topLevelNavigation.assign = original })
  return calls
}
const navRestores: Array<() => void> = []

type Route = (url: string, init?: RequestInit) => { status?: number; body: unknown }
function stubFetch(routes: Record<string, Route>): { calls: string[]; restore: () => void } {
  const calls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    const key = Object.keys(routes).find((route) => {
      const [method, prefix] = route.split(' ')
      return method === (init?.method ?? 'GET') && url.startsWith(prefix)
    })
    const result = key ? routes[key](url, init) : { status: 404, body: { error: 'not stubbed' } }
    return new Response(JSON.stringify(result.body), { status: result.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

function teardown(fetchStub?: { restore: () => void }) {
  cleanup()
  fetchStub?.restore()
  setFramed(false)
  while (navRestores.length) navRestores.pop()!()
}

const nudge = () =>
  fireEvent(window, new window.MessageEvent('message', { data: EMBED_CONNECT_DONE_MESSAGE, origin: window.location.origin }))

const EMBEDDED_RETURN = encodeURIComponent('/auth/embedded-complete')

/**
 * Click a link and report whether the APP prevented its default action. The
 * default is then cancelled regardless, so jsdom does not attempt the
 * navigation it cannot perform.
 */
function clickLink(link: Element): { prevented: boolean } {
  const result = { prevented: false }
  const observe = (event: Event) => {
    result.prevented = event.defaultPrevented
    event.preventDefault()
  }
  document.addEventListener('click', observe, { once: true })
  act(() => {
    link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  return result
}

// ── the shared link path (MCP servers panel, /credentials, Add to Slack) ───

/** The same call the panel's and /credentials' Re-connect links make. */
function ReconnectLink({ onDone, check }: { onDone: () => void; check: () => Promise<boolean> }) {
  const oauth = useEmbeddedOAuth()
  const conn = { id: 'mcp-1', auth: { authType: 'oauth2', flow: 'authcode' as const } }
  return (
    <>
      <a
        href={reconnectHref(conn, '/integrations?tab=servers')}
        onClick={(event) =>
          oauth.launchFromLink(event, { popupHref: reconnectHref(conn, '/auth/embedded-complete'), popupName: 'backstory-mcp-signin', check, onDone })
        }
      >
        Re-connect {oauth.waitingFor ? '(waiting)' : ''}
      </a>
      <EmbeddedOAuthStatus state={oauth} />
    </>
  )
}

test('a Re-connect link, framed: opens the sign-in in a popup and the frame does not follow the link', async (t) => {
  t.after(() => teardown())
  setFramed(true)
  const opens = stubWindowOpen()
  let landed = false
  let done = 0
  render(<ReconnectLink check={async () => landed} onDone={() => { done += 1 }} />)

  const click = clickLink(screen.getByRole('link'))
  assert.equal(click.prevented, true, 'the frame must not navigate')
  assert.equal(opens.length, 1)
  assert.equal(opens[0].name, 'backstory-mcp-signin')
  assert.match(opens[0].url, new RegExp(`returnTo=${EMBEDDED_RETURN}`), 'the popup lands on the page that notifies the frame')
  await screen.findByText(/waiting/)

  // The popup's message is a nudge; only the server's answer ends the wait.
  nudge()
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
  assert.equal(done, 0)
  landed = true
  nudge()
  await waitFor(() => assert.equal(done, 1))
})

test('a Re-connect link, top-level: the browser follows the link exactly as before', (t) => {
  t.after(() => teardown())
  const opens = stubWindowOpen()
  render(<ReconnectLink check={async () => true} onDone={() => {}} />)
  const link = screen.getByRole('link')
  assert.equal(link.getAttribute('href'), '/api/mcp-connections/oauth/start?connectionId=mcp-1&returnTo=%2Fintegrations%3Ftab%3Dservers')
  const click = clickLink(link)
  assert.equal(click.prevented, false)
  assert.equal(opens.length, 0)
})

test('a blocked popup is reported, and the frame still does not navigate', async (t) => {
  t.after(() => teardown())
  setFramed(true)
  stubWindowOpen(null)
  render(<ReconnectLink check={async () => true} onDone={() => {}} />)
  const click = clickLink(screen.getByRole('link'))
  assert.equal(click.prevented, true)
  assert.match((await screen.findByRole('alert')).textContent ?? '', /Allow pop-ups/)
})

// ── Add to Slack ──────────────────────────────────────────────────────────

const slackState = (installedAt: string | null) => ({
  provider: 'slack', label: 'Slack', fieldLabel: 'Bot token', hint: '', docsUrl: 'https://api.slack.com',
  hasOwnKey: installedAt !== null, configured: installedAt !== null, source: installedAt ? 'org' : null,
  hasSigningSecret: false, installedAt,
})

function stubCredentials(slack: () => unknown) {
  return stubFetch({
    'GET /api/integrations/credentials/slack': () => ({ body: slack() }),
    'GET /api/integrations/credentials/': (url) => ({ body: { ...slackState(null), provider: url.split('/').at(-1), label: url.split('/').at(-1) } }),
  })
}

test('Add to Slack, framed: installs in a popup and the row updates once the server shows the install', async (t) => {
  let installedAt: string | null = null
  const fetchStub = stubCredentials(() => slackState(installedAt))
  t.after(() => teardown(fetchStub))
  setFramed(true)
  const opens = stubWindowOpen()
  render(<WorkspaceCredentialsPanel />)
  const link = await screen.findByRole('link', { name: 'Add to Slack' })
  const click = clickLink(link)
  assert.equal(click.prevented, true)
  assert.deepEqual(opens, [{ url: `/api/slack/install?returnTo=${EMBEDDED_RETURN}`, name: 'backstory-slack-install' }])

  assert.ok(await screen.findByRole('status'), 'the row says it is waiting on the other window')
  // A nudge before the install lands changes nothing — the server still says no.
  nudge()
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
  assert.ok(screen.getByRole('status'))

  installedAt = '2026-10-22T12:00:00.000Z'
  nudge()
  await waitFor(() => assert.ok(!screen.queryByRole('status'), 'still waiting'))
  assert.ok(screen.getByText(/This workspace/))
})

test('Add to Slack, top-level: still a plain link to the install route', async (t) => {
  const fetchStub = stubCredentials(() => slackState(null))
  t.after(() => teardown(fetchStub))
  const opens = stubWindowOpen()
  render(<WorkspaceCredentialsPanel />)
  const link = await screen.findByRole('link', { name: 'Add to Slack' })
  assert.equal(link.getAttribute('href'), '/api/slack/install?returnTo=/settings')
  const click = clickLink(link)
  assert.equal(click.prevented, false)
  assert.equal(opens.length, 0)
})

// ── the MCP server detail dialog ──────────────────────────────────────────

const connection: SerializedConnection = {
  id: 'mcp-1',
  name: 'Backstory MCP Demo',
  description: null,
  serverUrl: 'https://mcp.people.ai/mcp',
  isActive: true,
  lastVerifiedAt: '2026-10-20T10:00:00.000Z',
  healthStatus: 'unhealthy',
  auth: { authType: 'oauth2', flow: 'authcode' },
}

function detailRoutes(listed: () => Partial<SerializedConnection>) {
  return stubFetch({
    'GET /api/mcp-connections/mcp-1/tools': () => ({
      body: {
        success: true,
        connection: { ...connection, provider: null, lastError: 'Token expired', needsSignIn: true, canManage: true, canEdit: true },
        items: [],
      },
    }),
    'GET /api/mcp-connections': () => ({ body: { success: true, connections: [{ ...connection, ...listed() }] } }),
  })
}

function openDetail(props: Partial<React.ComponentProps<typeof McpConnectionDetailDialog>> = {}) {
  return render(
    <McpConnectionDetailDialog
      connection={connection}
      returnTo="/integrations?tab=servers"
      verifying={false}
      onVerify={() => {}}
      onEdit={() => {}}
      onDisconnect={async () => {}}
      onClose={() => {}}
      {...props}
    />,
  )
}

test('detail dialog Reconnect, framed: popup, no frame navigation, refreshes in place once re-verified', async (t) => {
  let listed: Partial<SerializedConnection> = {}
  const fetchStub = detailRoutes(() => listed)
  t.after(() => teardown(fetchStub))
  setFramed(true)
  const opens = stubWindowOpen()
  const navigations = stubNavigation()
  let reconnected = 0
  openDetail({ onReconnected: () => { reconnected += 1 } })

  await screen.findByText('Token expired')
  fireEvent.click(screen.getAllByRole('button', { name: 'Reconnect' })[0])
  assert.deepEqual(navigations, [])
  assert.equal(opens.length, 1)
  assert.equal(opens[0].url, `/api/mcp-connections/oauth/start?connectionId=mcp-1&returnTo=${EMBEDDED_RETURN}`)

  listed = { lastVerifiedAt: '2026-10-22T12:00:00.000Z', healthStatus: 'healthy' }
  nudge()
  await waitFor(() => assert.equal(reconnected, 1))
  assert.deepEqual(navigations, [])
})

test('detail dialog Reconnect, top-level: redirects to the start route as before', async (t) => {
  const fetchStub = detailRoutes(() => ({}))
  t.after(() => teardown(fetchStub))
  const opens = stubWindowOpen()
  const navigations = stubNavigation()
  openDetail()
  await screen.findByText('Token expired')
  fireEvent.click(screen.getAllByRole('button', { name: 'Reconnect' })[0])
  assert.equal(opens.length, 0)
  assert.deepEqual(navigations, [reconnectHref(connection, '/integrations?tab=servers')])
})

// ── the add / edit MCP server dialog (SSO) ────────────────────────────────

function openSsoDialog(props: Partial<React.ComponentProps<typeof McpConnectionDialog>> = {}) {
  return render(
    <McpConnectionDialog open onOpenChange={() => {}} onSave={async () => {}} returnTo="/credentials" {...props} />,
  )
}

function fillSso(name: string, url: string) {
  fireEvent.click(screen.getByRole('radio', { name: 'OAuth 2.0 (SSO)' }))
  fireEvent.change(screen.getByPlaceholderText('e.g. Backstory MCP'), { target: { value: name } })
  fireEvent.change(screen.getByPlaceholderText('Streamable endpoint'), { target: { value: url } })
}

test('SSO Connect, framed: popup, no frame navigation; closes and refreshes once the new server exists', async (t) => {
  let rows: Array<Record<string, unknown>> = [{ id: 'old', name: 'Other', serverUrl: 'https://other.example/mcp', isActive: true, lastVerifiedAt: null }]
  const fetchStub = stubFetch({ 'GET /api/mcp-connections': () => ({ body: { success: true, connections: rows } }) })
  t.after(() => teardown(fetchStub))
  setFramed(true)
  const opens = stubWindowOpen()
  const navigations = stubNavigation()
  let closed = false
  let connected = 0
  openSsoDialog({ onOpenChange: (next) => { if (!next) closed = true }, onConnected: () => { connected += 1 } })
  fillSso('Linear', 'https://mcp.linear.app/mcp')

  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  assert.deepEqual(navigations, [])
  assert.equal(opens.length, 1)
  const popup = new URL(opens[0].url, 'http://localhost')
  assert.equal(popup.pathname, '/api/mcp-connections/oauth/start')
  assert.equal(popup.searchParams.get('returnTo'), '/auth/embedded-complete')
  assert.equal(popup.searchParams.get('name'), 'Linear')

  // Let the baseline read land before the callback creates the row.
  await waitFor(() => assert.ok(fetchStub.calls.includes('GET /api/mcp-connections')))
  rows = [...rows, { id: 'new', name: 'Linear', serverUrl: 'https://mcp.linear.app/mcp', isActive: true, lastVerifiedAt: '2026-10-22T12:00:00.000Z' }]
  nudge()
  await waitFor(() => assert.equal(connected, 1))
  assert.equal(closed, true)
})

test('SSO Connect, top-level: full-page redirect to the start route with the page as returnTo', (t) => {
  t.after(() => teardown())
  const opens = stubWindowOpen()
  const navigations = stubNavigation()
  openSsoDialog()
  fillSso('Linear', 'https://mcp.linear.app/mcp')
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  assert.equal(opens.length, 0)
  assert.equal(navigations.length, 1)
  const target = new URL(navigations[0], 'http://localhost')
  assert.equal(target.pathname, '/api/mcp-connections/oauth/start')
  assert.equal(target.searchParams.get('returnTo'), '/credentials')
  assert.equal(target.searchParams.get('serverUrl'), 'https://mcp.linear.app/mcp')
})

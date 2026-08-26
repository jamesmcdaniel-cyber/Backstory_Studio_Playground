import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import {
  McpConnectionDialog,
  draftAuthPayload,
  type SerializedConnection,
} from '../mcp-connection-dialog'

const noop = async () => {}

function open(editingConnection?: SerializedConnection) {
  return render(
    <McpConnectionDialog
      open
      onOpenChange={() => {}}
      onSave={noop}
      editingConnection={editingConnection ?? null}
    />,
  )
}

/** Pick an authentication mode by its visible label. */
function chooseAuth(label: string) {
  fireEvent.click(screen.getByRole('radio', { name: label }))
}

const ssoConnection: SerializedConnection = {
  id: 'mcp-1',
  name: 'Backstory MCP',
  description: 'Sales AI tools',
  serverUrl: 'https://mcp.people.ai/mcp',
  isActive: true,
  auth: { authType: 'oauth2', flow: 'authcode' },
}

// ── Access token ─────────────────────────────────────────────────────────────

test('a NEW server can be connected with nothing but an access token', (t) => {
  t.after(cleanup)
  open()
  // The option used to appear only while editing a server that already used
  // it, which made it unreachable for every server that did not.
  chooseAuth('Access token')
  assert.ok(screen.getByPlaceholderText('Paste your access token'))
})

test('the access token option sits alongside client credentials, not instead of it', (t) => {
  t.after(cleanup)
  open()
  for (const mode of ['None', 'Access token', 'Client credentials', 'OAuth 2.0 (SSO)']) {
    assert.ok(screen.getByRole('radio', { name: mode }), mode)
  }
})

test('a bearer is the default and the custom header is tucked away', (t) => {
  t.after(cleanup)
  open()
  chooseAuth('Access token')
  // A person pasting a token should not have to answer a header question:
  // almost every server wants a bearer, so the exception is behind a summary.
  // (Asserted structurally rather than by clicking the summary — a synthetic
  // click on <summary> hangs jsdom.)
  assert.ok(screen.getByText(/Authorization: Bearer/))
  assert.ok(screen.getByPlaceholderText('X-API-Key').closest('details'))
})

test('saving is blocked until the access token is there, and says why', (t) => {
  t.after(cleanup)
  open()
  chooseAuth('Access token')
  assert.ok(screen.getByText(/Enter an access token to test or save/i))
  const create = screen.getByRole('button', { name: 'Verify & create' })
  assert.equal((create as HTMLButtonElement).disabled, true)
})

test('an access token travels on the wire only when the user typed one', (t) => {
  t.after(cleanup)
  const base = {
    name: 'n8n', description: '', serverUrl: 'https://example.com/mcp',
    authMode: 'api_key' as const, headerName: '', clientId: '', clientSecret: '',
    tokenUrl: '', scopes: '',
  }
  assert.deepEqual(draftAuthPayload({ ...base, apiKey: 'tok-1' }), {
    authType: 'api_key',
    apiKey: 'tok-1',
  })
  // Blank on edit means "keep the stored one" — sending '' would overwrite a
  // working token with an empty envelope.
  assert.deepEqual(draftAuthPayload({ ...base, apiKey: '' }), { authType: 'api_key' })
})

// ── OAuth: one button ────────────────────────────────────────────────────────

test('the OAuth section offers Connect and nothing else', (t) => {
  t.after(cleanup)
  open()
  chooseAuth('OAuth 2.0 (SSO)')
  assert.ok(screen.getByRole('button', { name: 'Connect' }))
  // Signing in IS the create, and IS the verification — the callback stores the
  // tokens and stamps lastVerifiedAt. A Test connection and a Verify & create
  // underneath it could do nothing Connect had not already done.
  for (const gone of ['Verify & create', 'Verify & save', 'Test connection']) {
    assert.equal(screen.queryByRole('button', { name: gone }), null, gone)
  }
})

test('the OAuth call to action does not name the identity provider', (t) => {
  t.after(cleanup)
  open()
  chooseAuth('OAuth 2.0 (SSO)')
  assert.equal(screen.queryByRole('button', { name: /Connect with SSO/ }), null)
})

test('the other modes keep their test and save buttons', (t) => {
  t.after(cleanup)
  open()
  chooseAuth('Client credentials')
  assert.ok(screen.getByRole('button', { name: 'Test connection' }))
  assert.ok(screen.getByRole('button', { name: 'Verify & create' }))
})

// ── Re-connect ───────────────────────────────────────────────────────────────

test('an existing OAuth server offers Re-connect, with its URL already filled in', (t) => {
  t.after(cleanup)
  open(ssoConnection)
  assert.ok(screen.getByRole('button', { name: 'Re-connect' }))
  // The whole point: an expired connection is re-established from what we
  // already stored, not by re-typing the endpoint.
  const url = screen.getByPlaceholderText('Streamable endpoint') as HTMLInputElement
  assert.equal(url.value, 'https://mcp.people.ai/mcp')
})

test('editing an OAuth server can still rename it', (t) => {
  t.after(cleanup)
  open(ssoConnection)
  // Save survives where Verify & save was removed, because the name and
  // description are ordinary fields and something has to write them.
  assert.ok(screen.getByRole('button', { name: 'Save' }))
})

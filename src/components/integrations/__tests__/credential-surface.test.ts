import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Dead-code guards for the credential surface. WorkspaceCredentialsPanel (the
 * only per-provider-tailored credential UI: Slack bot token, Resend, Granola)
 * shipped orphaned — exported, imported nowhere — so the tailored fields,
 * hints and docs links never rendered. These pin the wiring.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

test('the settings page renders WorkspaceCredentialsPanel', () => {
  const page = read('src/app/settings/page.tsx')
  assert.match(page, /WorkspaceCredentialsPanel/, 'the workspace keys panel must be reachable from /settings')
})

test('the integrations page carries no password inputs', () => {
  // Chrome's password manager pairs a saved password with the nearest text
  // input as its "username" — which was the integrations search bar getting
  // the user's email autofilled. Workspace keys (password-type inputs) live
  // in Settings; this page must stay free of them.
  const page = read('src/app/integrations/page.tsx')
  assert.doesNotMatch(page, /WorkspaceCredentialsPanel/, 'workspace keys must not render on /integrations')
})

test('workspace key inputs opt out of saved-credential autofill', () => {
  const panel = read('src/components/integrations/workspace-credentials-panel.tsx')
  assert.match(
    panel,
    /autoComplete="new-password"/,
    'key inputs need autoComplete="new-password" — Chrome ignores "off" and fills saved site credentials',
  )
})

test('the credentials page is the full management surface', () => {
  // /credentials replaced the read-mostly bank on /flows: both OAuth and HTTP
  // rows expose rotation for exposed/leaked credentials. Workspace keys are
  // deliberately absent — agents act on behalf of the user who connected them,
  // never a shared workspace identity.
  const page = read('src/app/credentials/page.tsx')
  assert.doesNotMatch(page, /WorkspaceCredentialsPanel/, 'workspace keys must not render on /credentials')
  assert.match(page, /rotateCredential/, 'HTTP credential rotation must be wired into /credentials')
  assert.match(page, /kind: 'rotate'/, 'OAuth token rotation (revoke + reconnect) must be wired into /credentials')
})

test('the flows page links to the credentials page', () => {
  // The bank left /flows for its own page; the header button is the remaining
  // one-click path from flow building to credential management.
  const page = read('src/app/flows/page.tsx')
  assert.match(page, /href="\/credentials"/, 'the Flows header must keep a link to /credentials')
  assert.doesNotMatch(page, /CredentialsBank/, 'the inline bank was replaced by the dedicated page')
})

test('credentials is a flows-scoped surface, not a sidebar destination', () => {
  // Explicit product call (2026-08-07): /credentials is reached from the
  // Flows header only, and always offers the way back to /flows.
  const sidebar = read('src/components/layout/sidebar.tsx')
  assert.doesNotMatch(sidebar, /\/credentials/, 'the sidebar must not link to /credentials')
  const page = read('src/app/credentials/page.tsx')
  assert.match(page, /href="\/flows"/, 'the credentials page must link back to /flows')
})

test('the step-drawer predefined-credential empty state does not deny connected integrations', () => {
  const drawer = read('src/components/flows/step-drawer.tsx')
  assert.doesNotMatch(
    drawer,
    /No connected integrations yet/,
    'the empty state must not claim nothing is connected — Nango connections exist but are not MCP credentials',
  )
})

test('the OAuth grid carries per-provider connect guidance', () => {
  const grid = read('src/app/integrations/oauth-integrations-grid.tsx')
  assert.match(grid, /PROVIDER_CONNECT_HINTS|connectHint/, 'per-provider guidance registry must be wired into the grid')
})

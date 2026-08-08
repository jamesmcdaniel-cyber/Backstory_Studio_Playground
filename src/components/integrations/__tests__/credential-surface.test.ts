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

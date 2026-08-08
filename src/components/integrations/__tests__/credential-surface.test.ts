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

test('the integrations page renders WorkspaceCredentialsPanel', () => {
  const page = read('src/app/integrations/page.tsx')
  assert.match(page, /WorkspaceCredentialsPanel/, 'the workspace keys panel must be reachable from /integrations')
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

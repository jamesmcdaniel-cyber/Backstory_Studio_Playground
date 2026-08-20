import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Source-contract pins for the integration detail dialog (same style as the
 * layout and demo-chip contracts): the card opens the dialog without hijacking
 * its action buttons, and the dialog derives from the capabilities endpoint
 * rather than hard-coded copy.
 */
const grid = readFileSync(path.join(process.cwd(), 'src/app/integrations/oauth-integrations-grid.tsx'), 'utf8')
const dialog = readFileSync(path.join(process.cwd(), 'src/components/integrations/integration-detail-dialog.tsx'), 'utf8')

test('card click opens the detail dialog and is keyboard-reachable', () => {
  assert.match(grid, /onClick=\{\(\) => setDetailId\(integration\.id\)\}/)
  assert.match(grid, /tabIndex=\{0\}/)
  assert.match(grid, /event\.key === 'Enter'/)
})

test('card action buttons stop propagation so Connect never opens the dialog', () => {
  for (const action of ['connect(integration)', 'verify(integration)', 'disconnect(integration)']) {
    assert.match(grid, new RegExp(`stopPropagation\\(\\); ${action.replace(/[()]/g, '\\$&')}`))
  }
})

test('the dialog reads capabilities from the registry-backed endpoint', () => {
  assert.match(dialog, /\/api\/nango\/integrations\/.*capabilities/)
  assert.match(dialog, /What it can read/)
  assert.match(dialog, /What it can do/)
})

test('an unwired provider gets the honest empty state, not a blank dialog', () => {
  assert.match(dialog, /no agent tools use it yet/)
})

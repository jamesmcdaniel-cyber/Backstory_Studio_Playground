import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toolInventorySection } from '../execute-agent'

/**
 * Runs were reporting "I don't have any tools connected" while holding a
 * working connection: the model saw only tool schemas and inferred its own
 * capabilities. The inventory states them.
 */

test('loaded tools are named and asserted to be real', () => {
  const section = toolInventorySection([{ name: 'nango_gmail_send' }, { name: 'backstory_get_account' }], [])
  assert.match(section, /2 tools loaded/)
  assert.match(section, /nango_gmail_send/)
  assert.match(section, /backstory_get_account/)
  assert.match(section, /Never tell the user you have no tools/)
})

test('one tool is described in the singular', () => {
  assert.match(toolInventorySection([{ name: 'http_request' }], []), /1 tool loaded/)
})

test('an attached but unusable integration is named with its reason', () => {
  const section = toolInventorySection(
    [{ name: 'backstory_get_account' }],
    [{ name: 'Gmail', reason: 'No connected Gmail account resolved for this workspace — reconnect it in Integrations.' }],
  )
  assert.match(section, /Attached to this agent but NOT usable/)
  assert.match(section, /Gmail: No connected Gmail account resolved/)
  // The whole point: the run must not describe a broken Gmail as "no tools".
  assert.match(section, /Do not describe it as "no tools connected"/)
})

test('genuinely having nothing is stated plainly, without inventing a reason', () => {
  const section = toolInventorySection([], [])
  assert.match(section, /No tools loaded for this run/)
  assert.doesNotMatch(section, /Attached to this agent but NOT usable/)
})

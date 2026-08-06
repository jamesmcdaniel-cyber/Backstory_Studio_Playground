import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unmetRequirements, type WorkspaceConnections } from '../integration-match'

/**
 * The invariant: a template's "connect these first" banner names only what the
 * workspace is actually MISSING. Telling someone to connect Slack when Slack is
 * connected trains them to ignore the banner entirely.
 */

const WORKSPACE: WorkspaceConnections = {
  tools: [
    { key: 'slack', label: 'Slack', slug: 'slack', connected: true },
    { key: 'gmail', label: 'Gmail', slug: 'gmail', connected: true },
    { key: 'salesforce', label: 'Salesforce', slug: 'salesforce', connected: false },
    { key: 'HTTP API', label: 'HTTP API', slug: 'http', connected: true },
    { key: 'Granola', label: 'Granola', slug: 'granola', connected: false },
  ],
  connections: [{ id: 'c1', name: 'Backstory MCP' }],
}

const labels = (names: string[], state = WORKSPACE) => unmetRequirements(names, state).map((r) => r.label)

test('a connected integration drops off the requirement list', () => {
  assert.deepEqual(labels(['Slack']), [])
  assert.deepEqual(labels(['Gmail']), [])
})

test('an unconnected integration stays on the list', () => {
  assert.deepEqual(labels(['Salesforce']), ['Salesforce'])
  assert.deepEqual(labels(['Granola']), ['Granola'])
})

test('a fully connected template asks for nothing', () => {
  assert.deepEqual(labels(['Backstory MCP', 'Slack', 'Email']), [])
})

test('only the missing ones survive a mixed list', () => {
  assert.deepEqual(labels(['Backstory MCP', 'Slack', 'Salesforce', 'Granola']), ['Salesforce', 'Granola'])
})

test('"Email" is satisfied by a connected Gmail account', () => {
  // Templates say "Email"; the workspace connected it as Gmail. Same thing.
  assert.deepEqual(labels(['Email']), [])
})

test('plane-prefixed names resolve to the same tool', () => {
  assert.deepEqual(labels(['nango:slack']), [])
  assert.deepEqual(labels(['nango:salesforce']), ['Salesforce'])
})

test('a custom MCP server counts as connected by name', () => {
  const state: WorkspaceConnections = { tools: [], connections: [{ id: 'c9', name: 'Acme Warehouse' }] }
  assert.deepEqual(labels(['Acme Warehouse'], state), [])
  assert.deepEqual(labels(['Other Server'], state), ['Other Server'])
})

test('platform capabilities need no connection', () => {
  // HTTP/web/model are always available — never ask the user to "connect" them.
  assert.deepEqual(labels(['HTTP API', 'Web Search', 'LLM']), [])
})

test('a tool the workspace has never heard of is still reported missing', () => {
  assert.deepEqual(labels(['Snowflake']), ['Snowflake'])
})

test('duplicates collapse to one requirement', () => {
  assert.deepEqual(labels(['Salesforce', 'nango:salesforce', 'salesforce']), ['Salesforce'])
})

test('an unknown workspace state reports everything as unmet, never a false all-clear', () => {
  // Before /api/integrations/available answers, the caller has no evidence that
  // anything is connected — the banner must not silently vanish.
  assert.deepEqual(labels(['Slack', 'Salesforce'], { tools: [], connections: [] }), ['Slack', 'Salesforce'])
})

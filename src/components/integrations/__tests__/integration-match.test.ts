import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyRequirement, classifyRequirements, matchCatalogEntry } from '../integration-match'

const CATALOG = [
  { id: 'salesforce', provider: 'salesforce', name: 'Salesforce' },
  { id: 'salesforce-sandbox', provider: 'salesforce-sandbox', name: 'Salesforce Sandbox' },
  { id: 'snowflake-prod', provider: 'snowflake', name: 'Snowflake' },
  { id: 'google-mail', provider: 'google-mail', name: 'Gmail' },
]

test('matchCatalogEntry resolves plane-prefixed names to catalog entries', () => {
  assert.equal(matchCatalogEntry('nango:salesforce', CATALOG)?.id, 'salesforce')
  // Matched on provider, not the environment-suffixed config key.
  assert.equal(matchCatalogEntry('nango:snowflake', CATALOG)?.id, 'snowflake-prod')
  // Display-name match, so "Gmail" finds the google-mail config.
  assert.equal(matchCatalogEntry('Gmail', CATALOG)?.id, 'google-mail')
  assert.equal(matchCatalogEntry('Backstory MCP', CATALOG), null)
})

test('matchCatalogEntry resolves capability names through the logo alias table', () => {
  // Templates say "Email"; the environment calls the same thing google-mail.
  assert.equal(matchCatalogEntry('Email', CATALOG)?.id, 'google-mail')
})

test('matchCatalogEntry prefers the least-qualified key on a prefix match', () => {
  const catalog = [
    { id: 'hubspot-sandbox', provider: 'hubspot-sandbox', name: 'HubSpot Sandbox' },
    { id: 'hubspot-eu', provider: 'hubspot-eu', name: 'HubSpot EU' },
  ]
  assert.equal(matchCatalogEntry('hubspot', catalog)?.id, 'hubspot-eu')
})

test('classifyRequirement separates OAuth, MCP and built-in requirements', () => {
  const salesforce = classifyRequirement('nango:salesforce', CATALOG)
  assert.equal(salesforce.label, 'Salesforce')
  assert.equal(salesforce.kind, 'oauth')
  assert.equal(salesforce.entry?.id, 'salesforce')

  const mcp = classifyRequirement('Backstory MCP', CATALOG)
  assert.equal(mcp.kind, 'mcp')
  assert.equal(mcp.entry, null)

  assert.equal(classifyRequirement('HTTP API', CATALOG).kind, 'builtin')
  assert.equal(classifyRequirement('Webhook', CATALOG).kind, 'builtin')

  // Unknown to the catalog and not obviously built-in: still an account to connect.
  assert.equal(classifyRequirement('Intercom', CATALOG).kind, 'oauth')
})

test('classifyRequirement trusts the catalog over the naming heuristics', () => {
  // A workspace that genuinely offers an "api" integration must stay connectable.
  const catalog = [{ id: 'api', provider: 'api', name: 'API' }]
  assert.equal(classifyRequirement('API', catalog).kind, 'oauth')
})

test('classifyRequirements dedupes by display label', () => {
  const requirements = classifyRequirements(['nango:salesforce', 'salesforce', 'HTTP API'], CATALOG)
  assert.deepEqual(requirements.map((r) => r.label), ['Salesforce', 'HTTP API'])
})

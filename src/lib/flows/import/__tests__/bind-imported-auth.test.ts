import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bindImportedHttpAuth, dropStaleAuthWarnings } from '@/lib/flows/import/bind-imported-auth'
import type { FlowGraph } from '@/lib/flows/graph'

const httpNode = (id: string, label: string, url: string, data: Record<string, unknown> = {}) =>
  ({ id, type: 'http', data: { label, method: 'POST', url, ...data } }) as FlowGraph['nodes'][number]

const graphWith = (...nodes: FlowGraph['nodes']): FlowGraph => ({
  nodes: [{ id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } } as FlowGraph['nodes'][number], ...nodes],
  edges: [],
})

test('an exact-host credential binds without touching the URL', () => {
  const graph = graphWith(httpNode('n1', 'Upload file', 'https://api.example.com/upload'))
  const result = bindImportedHttpAuth(graph, {
    mcpConnections: [],
    httpCredentials: [{ id: 'cred-1', name: 'Example API', allowedHost: 'api.example.com' }],
  })
  const node = result.graph.nodes.find((n) => n.id === 'n1') as any
  assert.equal(node.data.credentialId, 'cred-1')
  assert.equal(node.data.url, 'https://api.example.com/upload')
  assert.deepEqual(result.boundLabels, ['Upload file'])
})

test('a sibling-host credential binds AND rewrites the placeholder host', () => {
  const graph = graphWith(
    httpNode('n1', 'Snowflake: DF Provisioning', 'https://YOUR_ACCOUNT.snowflakecomputing.com/api/v2/statements'),
  )
  const result = bindImportedHttpAuth(graph, {
    mcpConnections: [],
    httpCredentials: [{ id: 'cred-sf', name: 'Snowflake prod', allowedHost: 'acme-xy123.snowflakecomputing.com' }],
  })
  const node = result.graph.nodes.find((n) => n.id === 'n1') as any
  assert.equal(node.data.credentialId, 'cred-sf')
  assert.equal(node.data.url, 'https://acme-xy123.snowflakecomputing.com/api/v2/statements')
})

test('a brand-matching MCP connection binds as a predefined connection', () => {
  const graph = graphWith(httpNode('n1', 'Snowflake query', 'https://acme.snowflakecomputing.com/api/v2/statements'))
  const result = bindImportedHttpAuth(graph, {
    mcpConnections: [{ id: 'mcp-1', name: 'Snowflake' }],
    httpCredentials: [],
  })
  const node = result.graph.nodes.find((n) => n.id === 'n1') as any
  assert.equal(node.data.connectionId, 'mcp-1')
  assert.equal(node.data.credentialId, undefined)
})

test('already-authenticated, templated-URL, and unmatched steps are untouched', () => {
  const graph = graphWith(
    httpNode('bound', 'Bound', 'https://api.example.com/x', { credentialId: 'keep' }),
    httpNode('templated', 'Templated', '{{trigger.input.url}}'),
    httpNode('unmatched', 'Unmatched', 'https://api.other.com/x'),
  )
  const result = bindImportedHttpAuth(graph, {
    mcpConnections: [{ id: 'mcp-1', name: 'Snowflake' }],
    httpCredentials: [{ id: 'cred-1', name: 'Example', allowedHost: 'api.example.com' }],
  })
  assert.equal((result.graph.nodes.find((n) => n.id === 'bound') as any).data.credentialId, 'keep')
  assert.equal((result.graph.nodes.find((n) => n.id === 'templated') as any).data.credentialId, undefined)
  assert.equal((result.graph.nodes.find((n) => n.id === 'unmatched') as any).data.credentialId, undefined)
  assert.deepEqual(result.boundLabels, [])
})

test('stale hand-wire-the-auth warnings drop once their step is bound', () => {
  const warnings = [
    '“Upload file”: its n8n credential does not transfer — add the auth header (or an MCP connection) on the HTTP step before running.',
    '“Snowflake: DF Provisioning”: the platform’s integrations don’t cover Snowflake (no Snowflake integration exists yet) — imported as a direct API request (set your account host and add a key-pair JWT or OAuth token under Auth).',
    '“Other step”: its n8n credential does not transfer — add the auth header (or an MCP connection) on the HTTP step before running.',
  ]
  const kept = dropStaleAuthWarnings(warnings, ['Upload file', 'Snowflake: DF Provisioning'])
  assert.deepEqual(kept, [warnings[2]])
})

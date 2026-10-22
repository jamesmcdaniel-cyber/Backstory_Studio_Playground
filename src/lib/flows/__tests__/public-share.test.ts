import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyableFlowGraph, copyBlockers, PUBLIC_FLOW_VIEW_FIELDS, publicFlowView, publicLinkExpired } from '../public-share'
import { flowGraphSchema } from '../graph'

/**
 * The public link's serve-time boundary. publicFlowView builds the anonymous
 * payload field by field (deny by default); these pin that a Flow row carrying
 * every secret-bearing column still yields exactly the allowlisted keys, and
 * that nothing secret survives into them.
 */

const graph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'poll', connectionId: 'nango:salesforce' } } },
    {
      id: 'call',
      type: 'http',
      data: {
        label: 'Pull accounts',
        method: 'GET',
        url: 'https://crm.example.com/v2/accounts?api_key=SUPERSECRET',
        headers: '{"Authorization":"Bearer sk-live-DEADBEEFDEADBEEF"}',
        credentialId: 'cred_123',
        credentialResolverId: 'resolver_9',
      },
    },
    { id: 'act', type: 'tool', data: { label: 'Post', connectionId: 'mcp:conn_1', toolName: 'send_message', args: '{"channel":"#exec"}' } },
  ],
  edges: [
    { id: 'e0', source: 'trigger', target: 'call' },
    { id: 'e1', source: 'call', target: 'act' },
  ],
  pinData: { call: { rows: [{ email: 'ceo@customer.example' }] } },
}

// A row the way Prisma could hand it over if someone widened the select: every
// secret-bearing and run-bearing column present.
const LOADED_ROW = {
  id: 'flow_1',
  organizationId: 'org_secret',
  name: 'Lead router',
  description: 'Routes inbound leads',
  graph,
  publishedGraph: null,
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  publicAllowCopy: true,
  publicExpiresAt: null,
  shareTokenDigest: 'digest-of-jam-token',
  publicTokenDigest: 'digest-of-public-token',
  publicTokenCiphertext: 'v1:ciphertext',
  secretFindings: [{ path: 'graph.nodes[1]', preview: 'sk-•••' }],
  settings: { errorWorkflowId: 'flow_err' },
  trigger: { type: 'webhook', webhookSecretHash: 'hash' },
  pollCursor: { seen: ['a'] },
  userId: 'user_owner',
}

test('the anonymous payload has exactly the allowlisted fields', () => {
  const view = publicFlowView(LOADED_ROW)
  assert.deepEqual(Object.keys(view).sort(), [...PUBLIC_FLOW_VIEW_FIELDS].sort())
  assert.deepEqual([...PUBLIC_FLOW_VIEW_FIELDS].sort(), ['allowCopy', 'description', 'graph', 'name', 'stepCount', 'updatedAt'])
})

test('no secret-bearing value, id, run data or pinned output reaches a visitor', () => {
  const serialized = JSON.stringify(publicFlowView(LOADED_ROW))
  for (const leak of [
    'SUPERSECRET', 'sk-live-DEADBEEF', 'cred_123', 'resolver_9', 'nango:salesforce', 'mcp:conn_1', '#exec',
    'ceo@customer.example', 'pinData', 'org_secret', 'user_owner', 'digest-of', 'ciphertext', 'webhookSecretHash',
    'flow_err', 'secretFindings', 'pollCursor',
  ]) {
    assert.ok(!serialized.includes(leak), `"${leak}" leaked into the public payload`)
  }
  // The shape and author copy still render.
  assert.ok(serialized.includes('Pull accounts'))
  assert.equal(publicFlowView(LOADED_ROW).stepCount, 2)
})

test('a copy keeps the working steps but drops workspace ids and pinned data', () => {
  const copy = copyableFlowGraph(flowGraphSchema.parse(graph))
  const serialized = JSON.stringify(copy)
  assert.equal(copy.pinData, undefined)
  for (const gone of ['cred_123', 'resolver_9', 'mcp:conn_1', 'nango:salesforce', 'ceo@customer.example']) {
    assert.ok(!serialized.includes(gone), `"${gone}" must not cross into a copy`)
  }
  // The substance a copier came for is still there.
  assert.ok(serialized.includes('https://crm.example.com/v2/accounts'))
  assert.ok(serialized.includes('send_message'))
})

test('a copy still parses as a FlowGraph, so the copier lands in a working editor', () => {
  const withRefs = flowGraphSchema.parse({
    nodes: [
      { id: 't', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'a', type: 'tool', data: { connectionId: 'mcp:x', toolName: 'y', args: '{}' } },
      { id: 'b', type: 'agent', data: { agentId: 'agent_1', input: 'hi' } },
      { id: 'c', type: 'subflow', data: { flowId: 'flow_child', inputs: {} } },
    ],
    edges: [],
  })
  const parsed = flowGraphSchema.safeParse(copyableFlowGraph(withRefs))
  assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3)))
  assert.ok(!JSON.stringify(parsed.data).includes('agent_1'))
})

test('a literal credential blocks copying; a clean graph does not', () => {
  assert.ok(copyBlockers(graph) > 0, 'the Bearer token typed into the headers blocks a copy')
  const clean = { ...graph, nodes: graph.nodes.map((node) => (node.id === 'call' ? { ...node, data: { ...node.data, headers: '{}', url: 'https://crm.example.com/v2/accounts' } } : node)) }
  assert.equal(copyBlockers(clean), 0)
})

test('expiry: none never expires; a past time has expired', () => {
  assert.equal(publicLinkExpired(null), false)
  assert.equal(publicLinkExpired(new Date(Date.now() - 1000)), true)
  assert.equal(publicLinkExpired(new Date(Date.now() + 60_000)), false)
})

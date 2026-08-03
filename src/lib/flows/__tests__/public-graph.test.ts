import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { flowGraphSchema, type FlowGraph } from '../graph'
import { publicFlowGraph, publicUrl } from '../public-graph'

const here = path.dirname(fileURLToPath(import.meta.url))

// A graph carrying every kind of thing that must NOT reach an anonymous viewer.
const LOADED: FlowGraph = flowGraphSchema.parse({
  nodes: [
    {
      id: 'trigger',
      type: 'trigger',
      data: {
        trigger: {
          type: 'poll',
          // A poll trigger carries the org's connection id.
          connectionId: 'nango:salesforce',
          inputFields: [{ name: 'secretFieldName', type: 'string' }],
        },
      },
    },
    {
      id: 'call',
      type: 'http',
      data: {
        label: 'Pull accounts',
        note: 'Reads the CRM.',
        method: 'GET',
        url: 'https://crm.example.com/v2/accounts?api_key=SUPERSECRET',
        headers: '{"Authorization":"Bearer sk-live-DEADBEEF"}',
        body: '{"password":"hunter2"}',
        query: '{"token":"abc"}',
        cookie: 'session=xyz',
        credentialId: 'cred_123',
        connectionId: 'nango:salesforce',
      },
    },
    {
      id: 'act',
      type: 'tool',
      data: {
        label: 'Post to Slack',
        connectionId: 'nango:slack',
        toolName: 'send_message',
        args: '{"channel":"#private-exec","token":"xoxb-SECRET"}',
      },
    },
    {
      id: 'think',
      type: 'agent',
      data: { label: 'Summarize', agentId: 'agent_abc123', input: 'Use key sk-abc when calling {{step.call.output}}' },
    },
    {
      id: 'script',
      type: 'code',
      data: { label: 'Rank', language: 'javascript', code: 'const KEY = "sk-live-INSIDE-CODE"; return input' },
    },
    {
      id: 'ask',
      type: 'humanReview',
      data: { label: 'Approve', message: 'Approve {{step.think.output}} for {{trigger.input.account}}?' },
    },
    { id: 'child', type: 'subflow', data: { label: 'Run child', flowId: 'flow_child_id', inputs: {} } },
    {
      id: 'route',
      type: 'switch',
      data: {
        label: 'Route',
        cases: [{ id: 'hot', label: 'Hot', left: '{{step.think.output.score}}', op: 'gte', right: '8' }],
      },
    },
    { id: 'out', type: 'output', data: { label: 'Return', outputs: [{ name: 'plan', value: '{{step.think.output}}' }] } },
  ],
  edges: [
    { id: 'e0', source: 'trigger', target: 'call' },
    { id: 'e1', source: 'call', target: 'act' },
    { id: 'e2', source: 'act', target: 'think' },
    { id: 'e3', source: 'think', target: 'script' },
    { id: 'e4', source: 'script', target: 'ask' },
    { id: 'e5', source: 'ask', target: 'child' },
    { id: 'e6', source: 'child', target: 'route' },
    { id: 'e7', source: 'route', target: 'out', branch: 'hot' },
  ],
})

test('no secret-bearing value survives the anonymous projection', () => {
  const serialized = JSON.stringify(publicFlowGraph(LOADED))
  for (const secret of [
    'SUPERSECRET',
    'sk-live-DEADBEEF',
    'hunter2',
    'session=xyz',
    'cred_123',
    'xoxb-SECRET',
    'agent_abc123',
    'nango:slack',
    'nango:salesforce',
    'sk-live-INSIDE-CODE',
    'sk-abc',
    'flow_child_id',
    '#private-exec',
  ]) {
    assert.ok(!serialized.includes(secret), `"${secret}" leaked into the public graph`)
  }
  // Raw token syntax must never reach a UI — and prompts/expressions are where
  // it lives, so none of them cross either.
  assert.ok(!serialized.includes('{{'), 'a {{token}} reached the public graph')
})

test('shape and author copy DO survive, so the picture is still legible', () => {
  const publicGraph = publicFlowGraph(LOADED)
  assert.equal(publicGraph.nodes.length, LOADED.nodes.length, 'every node is represented')
  assert.equal(publicGraph.edges.length, LOADED.edges.length, 'the wiring is intact')
  assert.deepEqual(
    publicGraph.nodes.map((node) => node.type),
    LOADED.nodes.map((node) => node.type),
    'node types (the shape) are preserved in order',
  )
  const serialized = JSON.stringify(publicGraph)
  for (const copy of ['Pull accounts', 'Reads the CRM.', 'Post to Slack', 'Summarize', 'Approve', 'Hot']) {
    assert.ok(serialized.includes(copy), `author copy "${copy}" should survive`)
  }
  // A public tool name is not a secret; the connection behind it is blanked.
  const tool = publicGraph.nodes.find((node) => node.id === 'act')!
  assert.equal((tool.data as { toolName: string }).toolName, 'send_message')
  assert.equal((tool.data as { connectionId: string }).connectionId, '')
  // The branch label still rides the edge, so the canvas reads correctly.
  assert.equal(publicGraph.edges.find((edge) => edge.id === 'e7')?.branch, 'hot')
})

test('publicUrl keeps origin + path, drops the query, refuses templated/odd URLs', () => {
  assert.equal(publicUrl('https://api.example.com/v1/accounts?key=SECRET#frag'), 'https://api.example.com/v1/accounts')
  assert.equal(publicUrl('http://x.test/a/b'), 'http://x.test/a/b')
  // A templated URL could interpolate anything at run time — never echoed.
  assert.equal(publicUrl('{{var.base}}/accounts'), '')
  assert.equal(publicUrl('file:///etc/passwd'), '')
  assert.equal(publicUrl('not a url'), '')
  assert.equal(publicUrl(undefined), '')
})

test('the projection still parses as a FlowGraph (the preview renderer is typed against it)', () => {
  assert.doesNotThrow(() => flowGraphSchema.parse(publicFlowGraph(LOADED)))
})

test('every node type is classified in the allowlist — a new type cannot ship unclassified', () => {
  const graphSource = readFileSync(path.join(here, '..', 'graph.ts'), 'utf8')
  const declared = new Set(Array.from(graphSource.matchAll(/type: z\.literal\('(\w+)'\)/g), (m) => m[1]))
  const publicSource = readFileSync(path.join(here, '..', 'public-graph.ts'), 'utf8')
  const allowlistBlock = publicSource.slice(
    publicSource.indexOf('const PUBLIC_NODE_FIELDS'),
    publicSource.indexOf('/**\n * Required-by-schema fields'),
  )
  const classified = new Set(Array.from(allowlistBlock.matchAll(/^\s{2}(\w+):\s*\[/gm), (m) => m[1]))
  const missing = [...declared].filter((type) => !classified.has(type))
  assert.deepEqual(missing, [], `node type(s) missing from the public allowlist: ${missing.join(', ')}`)
})

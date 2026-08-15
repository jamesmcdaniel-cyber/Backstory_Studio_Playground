import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  extractFlowCapabilities,
  requiresCapabilityReview,
  summarizeCapabilities,
} from '../capabilities'
import type { FlowGraph } from '@/lib/flows/graph'

/**
 * Fixtures mirror the real n8n export that motivated this: a public webhook,
 * seven MCP tool calls against one server, and three code nodes. That shape —
 * "an unauthenticated entry point wired to your connected accounts" — is
 * exactly what an import review has to make legible, and it is invisible in a
 * node diagram.
 */

const graph = (nodes: Array<Record<string, unknown>>): FlowGraph =>
  ({ nodes, edges: [] }) as unknown as FlowGraph

test('a flow that only transforms data requests nothing', () => {
  // A real and reassuring answer, not a failure to analyse.
  const capabilities = extractFlowCapabilities(
    graph([{ id: 'a', type: 'transform', data: {} }, { id: 'b', type: 'filter', data: {} }]),
  )

  assert.deepEqual(capabilities, [])
  assert.equal(requiresCapabilityReview(capabilities), false)
  assert.match(summarizeCapabilities(capabilities), /only transforms data/)
})

test('a webhook trigger is surfaced as a public entry point', () => {
  const capabilities = extractFlowCapabilities(
    graph([{ id: 't', type: 'trigger', data: { trigger: { type: 'webhook', path: 'opportunity-dashboard' } } }]),
  )

  const webhook = capabilities.find((entry) => entry.kind === 'trigger.webhook')
  assert.ok(webhook, 'a public trigger must be reported')
  assert.equal(webhook.risk, 'high')
  assert.deepEqual(webhook.subjects, ['opportunity-dashboard'])
  assert.equal(requiresCapabilityReview(capabilities), true)
})

test('write calls are separated from reads', () => {
  // Collapsing both into "makes network calls" throws away the distinction the
  // reviewer most needs.
  const capabilities = extractFlowCapabilities(
    graph([
      { id: 'r', type: 'http', data: { url: 'https://api.example.com/read', method: 'GET' } },
      { id: 'w', type: 'http', data: { url: 'https://api.example.com/write', method: 'POST' } },
    ]),
  )

  const write = capabilities.find((entry) => entry.kind === 'network.write')
  const read = capabilities.find((entry) => entry.kind === 'network.read')

  assert.equal(write?.risk, 'high')
  assert.deepEqual(write?.subjects, ['POST api.example.com'])
  assert.equal(read?.risk, 'low')
  assert.deepEqual(read?.subjects, ['api.example.com'])
})

test('a URL built at run time is reported as unreviewable, not skipped', () => {
  // An unknowable destination is a finding, not an absence of one.
  const capabilities = extractFlowCapabilities(
    graph([{ id: 'h', type: 'http', data: { url: 'https://{{step.host}}/path', method: 'GET' } }]),
  )

  const dynamic = capabilities.find((entry) => entry.kind === 'network.dynamic')
  assert.ok(dynamic)
  assert.equal(dynamic.risk, 'high')
})

test('write-shaped tool names are ranked above read tools', () => {
  const capabilities = extractFlowCapabilities(
    graph([
      { id: '1', type: 'tool', data: { connectionId: 'c1', toolName: 'get_opportunity_status' } },
      { id: '2', type: 'tool', data: { connectionId: 'c1', toolName: 'create_salesforce_task' } },
    ]),
  )

  const write = capabilities.find((entry) => entry.kind === 'tool.write')
  const read = capabilities.find((entry) => entry.kind === 'tool.read')

  assert.equal(write?.risk, 'high')
  assert.deepEqual(write?.subjects, ['create_salesforce_task'])
  assert.equal(read?.risk, 'medium')
  assert.deepEqual(read?.subjects, ['get_opportunity_status'])
})

test('credential use is reported once, listing every place it happens', () => {
  // The seven-MCP-node shape: one capability, seven requesting nodes. Seven
  // near-identical rows would be scrolled past.
  const nodes = Array.from({ length: 7 }, (_, index) => ({
    id: `n${index}`,
    type: 'tool',
    data: { connectionId: 'mcp-people-ai', toolName: `get_thing_${index}` },
  }))
  const capabilities = extractFlowCapabilities(graph(nodes))

  const credential = capabilities.filter((entry) => entry.kind === 'credential.use')
  assert.equal(credential.length, 1, 'one capability, not one per node')
  assert.equal(credential[0].nodeIds.length, 7, 'but every requesting node is listed')
})

test('code nodes are reported with their sandbox limits stated', () => {
  const capabilities = extractFlowCapabilities(
    graph([{ id: 'c', type: 'code', data: { language: 'python', code: 'print(1)' } }]),
  )

  const code = capabilities.find((entry) => entry.kind === 'code.execute')
  assert.ok(code)
  // Honest scoping matters: overstating the risk of a sandboxed step is how a
  // review screen loses credibility and gets clicked through.
  assert.match(code.detail, /no network or file access/)
  assert.deepEqual(code.subjects, ['python'])
})

test('capabilities are ordered highest risk first', () => {
  // A review screen is read top-down and often not to the bottom, so ordering
  // decides what actually gets considered.
  const capabilities = extractFlowCapabilities(
    graph([
      { id: 'r', type: 'http', data: { url: 'https://api.example.com/x', method: 'GET' } },
      { id: 'c', type: 'code', data: { language: 'javascript' } },
      { id: 't', type: 'trigger', data: { trigger: { type: 'webhook', path: 'p' } } },
    ]),
  )

  assert.equal(capabilities[0].risk, 'high')
  assert.equal(capabilities[capabilities.length - 1].risk, 'low')
})

test('read-only network access alone does not demand a review', () => {
  // Prompting on every import trains people to click through, which costs more
  // than it protects.
  const capabilities = extractFlowCapabilities(
    graph([{ id: 'r', type: 'http', data: { url: 'https://api.example.com/x', method: 'GET' } }]),
  )
  assert.equal(requiresCapabilityReview(capabilities), false)
})

test('the real-world shape: webhook + credentialed MCP tools + code', () => {
  const capabilities = extractFlowCapabilities(
    graph([
      { id: 't', type: 'trigger', data: { trigger: { type: 'webhook', path: 'opportunity-dashboard' } } },
      { id: 'm1', type: 'tool', data: { connectionId: 'mcp', toolName: 'find_record_by_crm_id' } },
      { id: 'm2', type: 'tool', data: { connectionId: 'mcp', toolName: 'ask_sales_ai_about_opportunity' } },
      { id: 'c1', type: 'code', data: { language: 'javascript' } },
    ]),
  )

  const kinds = capabilities.map((entry) => entry.kind)
  assert.ok(kinds.includes('trigger.webhook'))
  assert.ok(kinds.includes('credential.use'))
  assert.ok(kinds.includes('code.execute'))
  assert.equal(requiresCapabilityReview(capabilities), true)

  // The summary is what a person reads before clicking, so it must lead with
  // the high-risk items rather than whatever came first in the graph.
  assert.match(summarizeCapabilities(capabilities), /public web address|connected accounts/)
})

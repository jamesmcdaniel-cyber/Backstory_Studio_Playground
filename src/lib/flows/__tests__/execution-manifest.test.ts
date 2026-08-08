import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFlowExecutionManifest, executionManifestMatches } from '../execution-manifest'
import type { FlowGraph } from '../graph'

const graph: FlowGraph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: {} },
    { id: 'agent', type: 'agent', data: { agentId: 'a1', input: 'go' } },
    { id: 'tool', type: 'tool', data: { connectionId: 'mcp1', toolName: 'read', args: '{}' } },
  ],
  edges: [
    { id: 'e1', source: 'trigger', target: 'agent' },
    { id: 'e2', source: 'agent', target: 'tool' },
  ],
}

function manifest(updatedAt = '2026-08-02T00:00:00.000Z', required = ['id'], models = ['agent-model', 'summary-model']) {
  return buildFlowExecutionManifest({
    graph,
    agents: [{ id: 'a1', updatedAt }, { id: 'unused', updatedAt }],
    toolCatalog: [{ id: 'mcp1', tools: [{ name: 'read', inputSchema: { type: 'object', required } }] }],
    agentModel: models[0],
    summaryModel: models[1],
  })
}

test('execution manifest is deterministic and excludes unused dependencies', () => {
  const first = manifest()
  const second = manifest()
  assert.deepEqual(first, second)
  assert.deepEqual(first.agents.map((agent) => agent.id), ['a1'])
  assert.deepEqual(first.tools.map((tool) => tool.name), ['read'])
})

test('agent revisions and tool schema drift invalidate a pinned manifest', () => {
  const pinned = manifest()
  assert.equal(executionManifestMatches(pinned, manifest()), true)
  assert.equal(executionManifestMatches(pinned, manifest('2026-08-02T00:01:00.000Z')), false)
  assert.equal(executionManifestMatches(pinned, manifest(undefined, ['accountId'])), false)
})

test('default-model env drift alone never invalidates a pinned manifest', () => {
  // The manifest is pinned on the web process and re-checked on the worker
  // fleet, which resolves AGENT_MODEL/SUMMARY_MODEL from its own env. A model
  // default that differs between the two planes (or changes in a deploy) must
  // not kill runs whose graph, agents, and tools are untouched.
  const pinned = manifest()
  assert.equal(executionManifestMatches(pinned, manifest(undefined, undefined, ['other-agent-model', 'other-summary-model'])), true)
  // ...but real dependency drift still fails even when models also differ.
  assert.equal(executionManifestMatches(pinned, manifest('2026-08-02T00:01:00.000Z', undefined, ['other-agent-model', 'other-summary-model'])), false)
})

test('a pinned tool absent from the current catalog is not drift', () => {
  // A tool-plane outage (or deleted connection) makes the catalog come back
  // without the tool. That is an availability problem the step itself will
  // report with a real error — not a schema change that invalidates the run.
  const pinned = manifest()
  const withoutTool = buildFlowExecutionManifest({
    graph,
    agents: [{ id: 'a1', updatedAt: '2026-08-02T00:00:00.000Z' }],
    toolCatalog: [],
    agentModel: 'agent-model',
    summaryModel: 'summary-model',
  })
  assert.equal(executionManifestMatches(pinned, withoutTool), true)
  // The reverse also passes: a tool the pin-time catalog missed appearing now
  // is added capability, not drift.
  assert.equal(executionManifestMatches(withoutTool, pinned), true)
  // But a schema change on a tool present in BOTH catalogs still fails.
  assert.equal(executionManifestMatches(pinned, manifest(undefined, ['accountId'])), false)
})

test('legacy runs without a manifest remain resumable', () => {
  assert.equal(executionManifestMatches(null, manifest()), true)
})

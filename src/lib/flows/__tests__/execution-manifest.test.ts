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

function manifest(objective = 'Summarise the account', required = ['id'], models = ['agent-model', 'summary-model']) {
  return buildFlowExecutionManifest({
    graph,
    agents: [{ id: 'a1', description: 'Agent', objective }, { id: 'unused', description: 'Unused', objective }],
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
  assert.equal(executionManifestMatches(pinned, manifest('Summarise the account, then email it')), false)
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
  assert.equal(executionManifestMatches(pinned, manifest('Summarise the account, then email it', undefined, ['other-agent-model', 'other-summary-model'])), false)
})

test('a pinned tool absent from the current catalog is not drift', () => {
  // A tool-plane outage (or deleted connection) makes the catalog come back
  // without the tool. That is an availability problem the step itself will
  // report with a real error — not a schema change that invalidates the run.
  const pinned = manifest()
  const withoutTool = buildFlowExecutionManifest({
    graph,
    agents: [{ id: 'a1', description: 'Agent', objective: 'Summarise the account' }],
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

// Regression: the manifest pinned AgentTask.updatedAt, an @updatedAt column
// every completed run bumps (lastExecutedAt / executionCount / lastResult) —
// including the run the flow's own agent step made. A flow whose agent step
// finished before a pause therefore could never resume.
test('an agent run bumping its own bookkeeping is not drift', () => {
  const agent = { id: 'a1', description: 'Agent', objective: 'Summarise the account', goal: null, context: {}, metadata: { model: 'x' } }
  const before = buildFlowExecutionManifest({ graph, agents: [{ ...agent, updatedAt: new Date('2026-08-02T00:00:00Z') } as never], toolCatalog: [], agentModel: 'm', summaryModel: 's' })
  const after = buildFlowExecutionManifest({
    graph,
    agents: [{ ...agent, updatedAt: new Date('2026-08-02T00:05:00Z'), lastExecutedAt: new Date(), executionCount: 7, lastResult: { summary: 'done' } } as never],
    toolCatalog: [],
    agentModel: 'm',
    summaryModel: 's',
  })
  assert.equal(executionManifestMatches(before, after), true)
  assert.equal(before.dependencyHash, after.dependencyHash)
})

test('a config change is drift; a schedule change is not', () => {
  const base = { id: 'a1', description: 'Agent', objective: 'Go', metadata: { tools: ['slack'] } }
  const pin = (agent: Record<string, unknown>) => buildFlowExecutionManifest({ graph, agents: [agent as never], toolCatalog: [], agentModel: 'm', summaryModel: 's' })
  const pinned = pin(base)
  assert.equal(executionManifestMatches(pinned, pin({ ...base, metadata: { tools: ['slack', 'gmail'] } })), false)
  // When an agent runs on its own has no bearing on what it does as a step.
  assert.equal(executionManifestMatches(pinned, pin({ ...base, schedule: { cadence: 'daily' } })), true)
})

test('a published agent pins its published config, not the draft', () => {
  const published = { description: 'Agent', objective: 'Published objective', connectorKeys: ['slack'] }
  const pin = (agent: Record<string, unknown>) => buildFlowExecutionManifest({ graph, agents: [agent as never], toolCatalog: [], agentModel: 'm', summaryModel: 's' })
  const pinned = pin({ id: 'a1', description: 'Agent', objective: 'Draft one', publishedConfig: published })
  // Editing the draft changes nothing a run executes.
  assert.equal(executionManifestMatches(pinned, pin({ id: 'a1', description: 'Agent', objective: 'Draft two', publishedConfig: published })), true)
  // Republishing does.
  assert.equal(executionManifestMatches(pinned, pin({ id: 'a1', description: 'Agent', objective: 'Draft two', publishedConfig: { ...published, objective: 'New published' } })), false)
})

test('a manifest pinned on updatedAt (before config revisions) still resumes', () => {
  const legacy = { ...manifest(), agents: [{ id: 'a1', updatedAt: '2026-08-02T00:00:00.000Z' }], dependencyHash: 'legacy' }
  assert.equal(executionManifestMatches(legacy, manifest('Something else entirely')), true)
  // ...while a tool schema change still fails it.
  assert.equal(executionManifestMatches(legacy, manifest(undefined, ['accountId'])), false)
})

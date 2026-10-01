import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capDiscoveredTools, selectDiscoveredTools, type DiscoveredTool } from '../execute-agent'

const client = { executeTool: async () => ({}) }

test('allowlisted tools survive a large catalog before the global cap', async () => {
  const list = Array.from({ length: 100 }, (_, i) => tool(`tool_${i}`, false))
  const selected = await selectDiscoveredTools(list, 'org1', undefined, { mode: 'allowlist', allowedTools: ['tool_99'] })
  assert.deepEqual(selected.tools.map(t => t.name), ['tool_99'])
  assert.equal(selected.bindings.size, 1)
})
function tool(name: string, isWrite: boolean): DiscoveredTool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    binding: { provider: isWrite ? 'nango:slack' : 'read', serverUrl: 'x', toolName: name, isWrite, client },
    isWrite,
  }
}

test('write tools are never crowded out by many read tools (reserved budget)', () => {
  // 70 read tools (over the 64 cap) + 3 write tools loaded "last".
  const reads = Array.from({ length: 70 }, (_, i) => tool(`read_${i}`, false))
  const writes = [tool('nango_slack', true), tool('nango_gmail', true), tool('slack_post', true)]
  const { tools, bindings } = capDiscoveredTools([...reads, ...writes], 'org1')

  assert.equal(tools.length, 64) // capped
  for (const w of writes) {
    assert.ok(bindings.has(w.name), `write tool ${w.name} must survive the cap`)
  }
})

test('dedupes by name (first wins) and respects the total cap', () => {
  const list = [tool('a', false), tool('a', false), tool('b', true)]
  const { tools } = capDiscoveredTools(list, 'org1')
  assert.deepEqual(tools.map((t) => t.name).sort(), ['a', 'b'])
})

test('under the cap, everything is kept', () => {
  const list = [tool('r1', false), tool('w1', true), tool('r2', false)]
  const { tools } = capDiscoveredTools(list, 'org1')
  assert.equal(tools.length, 3)
})

test('selectDiscoveredTools falls back to the deterministic cap without embeddings', async () => {
  // No VOYAGE_API_KEY in the test env → embeddingsConfigured() is false, so
  // selection must match capDiscoveredTools exactly (no network, deterministic).
  const prev = process.env.VOYAGE_API_KEY
  delete process.env.VOYAGE_API_KEY
  try {
    const reads = Array.from({ length: 70 }, (_, i) => tool(`read_${i}`, false))
    const writes = [tool('w_a', true), tool('w_b', true)]
    const list = [...reads, ...writes]
    const selected = await selectDiscoveredTools(list, 'org1', 'send a slack message about the renewal')
    const capped = capDiscoveredTools(list, 'org1')
    assert.deepEqual(selected.tools.map((t) => t.name), capped.tools.map((t) => t.name))
    assert.equal(selected.tools.length, 64)
  } finally {
    if (prev === undefined) delete process.env.VOYAGE_API_KEY
    else process.env.VOYAGE_API_KEY = prev
  }
})

test('selectDiscoveredTools under the cap keeps all tools (no embedding call)', async () => {
  const list = [tool('r1', false), tool('w1', true)]
  const selected = await selectDiscoveredTools(list, 'org1', 'anything')
  assert.equal(selected.tools.length, 2)
})

test('requested integration reads survive a large MCP catalog without embeddings', async () => {
  const reads = Array.from({ length: 90 }, (_, i) => tool(`unrelated_catalog_${i}`, false))
  const required = ['nango_github_list_repositories', 'nango_salesforce_query', 'n8n_list_workflow_tags', 'backstory_top_records']
  const list = [...reads, ...required.map(name => tool(name, false)), tool('artifact_edit_artifact', true)]
  const selected = capDiscoveredTools(list, 'org1', 'Read GitHub repositories, Salesforce query, n8n workflow tags and Backstory top records; edit artifact.')
  for (const name of [...required, 'artifact_edit_artifact']) assert.ok(selected.bindings.has(name), name)
  assert.equal(selected.tools.length, 64)
})

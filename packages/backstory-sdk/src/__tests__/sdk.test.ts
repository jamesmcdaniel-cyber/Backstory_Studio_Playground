import test from 'node:test'
import assert from 'node:assert/strict'
import { defineAgent, defineTool } from '../agent.js'
import { FlowBuilder, validateWorkflow, workflow } from '../workflow.js'
import { runEvalSuite } from '../eval.js'

test('workflow builder emits a validated graph-v2 round trip', () => {
  const builder = workflow().trigger({ type: 'manual' })
  const output = builder.node('output', { outputs: [{ name: 'ok', value: 'yes', type: 'text' }] }, { id: 'output' })
  builder.connect('trigger', output, { connectionType: 'main', sourceOutput: 0, targetInput: 0 })
  const graph = builder.toJSON()
  assert.equal(graph.schemaVersion, 2)
  assert.deepEqual(validateWorkflow(graph), [])
  assert.deepEqual(FlowBuilder.fromJSON(graph).toJSON(), graph)
})

test('workflow node and edge contracts match the runtime graph vocabulary', () => {
  const builder = workflow().trigger({ type: 'manual' })
  const variable = builder.node('variable', { op: 'initialize', name: 'count', value: '0' })
  const join = builder.node('join', { mode: 'append' })
  const stop = builder.node('stop', { reason: 'done' })
  builder.connect('trigger', variable).connect(variable, join, { sourceOutput: 1, targetInput: 2 }).connect(join, stop)
  const graph = builder.toJSON()
  assert.deepEqual(graph.nodes.map((node) => node.type), ['trigger', 'variable', 'join', 'stop'])
  assert.equal(graph.edges[1].sourceOutput, 1)
  assert.equal(graph.edges[1].targetInput, 2)
})

test('replacing a custom-id trigger preserves its edges', () => {
  const builder = FlowBuilder.fromJSON({
    schemaVersion: 2,
    nodes: [
      { id: 'start', type: 'trigger', typeVersion: 1, data: { trigger: { type: 'manual' } } },
      { id: 'done', type: 'output', typeVersion: 1, data: { outputs: [] } },
    ],
    edges: [{ id: 'edge', source: 'start', target: 'done', connectionType: 'main', sourceOutput: 0, targetInput: 0 }],
  })
  builder.trigger({ type: 'schedule', expression: '0 9 * * *' })
  const graph = builder.toJSON()
  assert.equal(graph.nodes[0].id, 'start')
  assert.equal(graph.edges[0].source, 'start')
})

test('agent definitions enforce unique tools', () => {
  const tool = defineTool({ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' }, execute: () => true })
  assert.equal(defineAgent({ name: 'A', instructions: 'Help', tools: [tool] }).tools[0], tool)
  assert.throws(() => defineAgent({ name: 'A', instructions: 'Help', tools: [tool, tool] }), /unique/)
})

test('eval runner bounds concurrency while preserving case order', async () => {
  const results = await runEvalSuite({
    name: 'double',
    cases: [{ id: 'a', input: 1, expected: 2 }, { id: 'b', input: 2, expected: 4 }],
    run: async (input) => input * 2,
    score: (output, expected) => ({ score: output === expected ? 1 : 0 }),
  })
  assert.deepEqual(results.map((result) => [result.caseId, result.output, result.score?.score]), [['a', 2, 1], ['b', 4, 1]])
})

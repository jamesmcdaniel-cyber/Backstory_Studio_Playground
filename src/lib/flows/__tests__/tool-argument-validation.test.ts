import test from 'node:test'
import assert from 'node:assert/strict'
import { toolArgumentIssues } from '../tool-argument-validation'
import { validateFlowGraph } from '../validate'
import type { FlowGraph } from '../graph'

test('nested types/enums are checked, dynamic tokens deferred', () => {
  const schema = { type: 'object', properties: { columns: { type: 'array', items: { type: 'object', required: ['type'], properties: { type: { type: 'string', enum: ['string', 'number'] } } } } } }
  assert.match(toolArgumentIssues({ columns: [{ type: 'text' }] }, schema).join(), /columns\[0\].type must be one of/)
  assert.equal(toolArgumentIssues({ columns: [{ type: 'string' }] }, schema).length, 0)
  assert.equal(toolArgumentIssues({ columns: '{{trigger.input.columns}}' }, schema).length, 0)
  assert.match(toolArgumentIssues({ columns: [{}] }, schema).join(), /is required/)
})

test('public HTTP is explicit and cannot also bind credentials', () => {
  const graph: FlowGraph = { nodes: [{ id: 'trigger', type: 'trigger', data: {} }, { id: 'h', type: 'http', data: { url: 'https://example.com', method: 'GET' } }], edges: [{ id: 'e', source: 'trigger', target: 'h' }] }
  assert.ok(validateFlowGraph(graph).errors.some(e => e.code === 'HTTP_NO_AUTH'))
  const node = graph.nodes[1]
  if (node.type !== 'http') throw new Error('Wrong fixture')
  node.data.authMode = 'public'
  assert.equal(validateFlowGraph(graph).errors.length, 0)
  node.data.credentialId = 'secret'
  assert.ok(validateFlowGraph(graph).errors.some(e => e.code === 'AMBIGUOUS_HTTP_AUTH'))
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { flowNodeSchema } from '../graph'
import { emptyGraph } from '../graph'
import { insertNodeAfter } from '../mutate'
import { validateFlowGraph } from '../validate'

test('code node schema supports JavaScript and Python with bounded execution settings', () => {
  for (const language of ['javascript', 'python'] as const) {
    const parsed = flowNodeSchema.parse({
      id: language,
      type: 'code',
      data: { language, mode: 'all', code: 'return input', input: '{{trigger.input}}', timeoutMs: 5000 },
    })
    assert.equal(parsed.type, 'code')
    if (parsed.type === 'code') assert.equal(parsed.data.language, language)
  }
  assert.equal(flowNodeSchema.safeParse({
    id: 'bad',
    type: 'code',
    data: { language: 'python', mode: 'all', code: 'return input', timeoutMs: 30_001 },
  }).success, false)
})

test('new code steps have runnable defaults and empty code is rejected by validation', () => {
  const inserted = insertNodeAfter(emptyGraph(), 'trigger', 'code')
  const node = inserted.graph.nodes.find((entry) => entry.id === inserted.nodeId)
  assert.equal(node?.type, 'code')
  if (node?.type === 'code') {
    assert.equal(node.data.language, 'javascript')
    assert.equal(node.data.code, 'return input;')
    node.data.code = ''
  }
  const result = validateFlowGraph(inserted.graph)
  assert.ok(result.errors.some((issue) => issue.code === 'EMPTY_CODE'))
})

import test from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph } from '@/lib/flows/graph'
import { interpretFlow, type RunActionFn } from '../interpret'

test('code step receives resolved structured input and threads adapter output', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      {
        id: 'code1',
        type: 'code',
        data: {
          language: 'python',
          mode: 'each',
          code: 'return input',
          input: '{{trigger.input.records}}',
          timeoutMs: 3000,
        },
      },
      { id: 'out', type: 'transform', data: { fields: [{ name: 'result', value: '{{step.code1.output}}' }] } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'code1' },
      { id: 'e2', source: 'code1', target: 'out' },
    ],
  }
  let config: Record<string, unknown> | undefined
  const runAction: RunActionFn = async (node) => {
    assert.equal(node.kind, 'code')
    config = node.config
    return { output: [{ doubled: 4 }, { doubled: 10 }] }
  }
  const result = await interpretFlow(graph, { records: [{ value: 2 }, { value: 5 }] }, {
    runAgent: async () => ({ output: 'unused' }),
    runAction,
  })

  assert.deepEqual(config?.input, [{ value: 2 }, { value: 5 }])
  assert.equal(config?.language, 'python')
  assert.equal(config?.mode, 'each')
  assert.deepEqual(result.output, { result: [{ doubled: 4 }, { doubled: 10 }] })
})

test('code step applies continue-on-error without executing downstream twice', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'code1', type: 'code', data: { language: 'javascript', mode: 'all', code: 'throw new Error("no")', input: '{{trigger.input}}', onError: 'continue' } },
      { id: 'after', type: 'transform', data: { fields: [{ name: 'ok', value: 'true' }] } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'code1' },
      { id: 'e2', source: 'code1', target: 'after' },
    ],
  }
  let calls = 0
  const result = await interpretFlow(graph, 'x', {
    runAgent: async () => ({ output: 'unused' }),
    runAction: async () => {
      calls += 1
      return { error: 'no' }
    },
  })
  assert.equal(calls, 1)
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(result.output, { ok: true })
})

test('a slow node reports a real execution span, not a fabricated zero', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'code1', type: 'code', data: { language: 'javascript', mode: 'all', code: 'return input', input: '{{trigger.input}}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'code1' }],
  }
  const before = Date.now()
  const result = await interpretFlow(graph, 'x', {
    runAgent: async () => ({ output: 'unused' }),
    runAction: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return { output: 'done' }
    },
  })
  const elapsed = Date.now() - before
  assert.equal(result.status, 'succeeded')
  const step = result.steps.find((s) => s.nodeId === 'code1')
  assert.ok(step, 'the slow step must have an outcome')
  const span = step!.finishedAt.getTime() - step!.startedAt.getTime()
  assert.ok(span >= 45, `expected a real span (>=45ms for a 50ms node), got ${span}ms`)
  assert.ok(span <= elapsed + 5, `span (${span}ms) must not exceed the run's total wall-clock time (${elapsed}ms)`)
})

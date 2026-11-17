/**
 * Every run-behaviour option the step panel offers reaches the runtime.
 *
 * The interpreter builds a whitelist config for tool/http steps, and it left
 * out "Wait Between Tries" (retryDelayMs) and "Always Output Data" — so the
 * ROI data pull's 30s wait between tries actually retried after 500ms, and the
 * toggle never reached applyAlwaysOutputData. Agent steps used a fixed backoff
 * and ignored Always Output Data. Knowledge steps were offered options their
 * schema cannot store.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunActionFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'
import { nodeOptions } from '@/lib/flows/node-options'
import { ROI_DATA_PULL_DATABRICKS } from '@/lib/roi/data-flow-template'

const chain = (step: FlowGraph['nodes'][number]): FlowGraph => ({
  nodes: [{ id: 'trigger', type: 'trigger', data: {} }, step],
  edges: [{ id: 'e', source: 'trigger', target: step.id }],
})

test('tool and http steps forward Wait Between Tries and Always Output Data', async () => {
  const seen: Record<string, unknown>[] = []
  const runAction: RunActionFn = async (node) => { seen.push(node.config); return { output: { ok: true } } }
  await interpretFlow(chain({ id: 't', type: 'tool', data: { connectionId: 'c', toolName: 'x', args: '{}', retries: 2, retryDelayMs: 30_000, alwaysOutputData: true } }), '', { runAgent: async () => ({ output: '' }), runAction })
  await interpretFlow(chain({ id: 'h', type: 'http', data: { method: 'GET', url: 'https://api.example.com', retries: 1, retryDelayMs: 5_000, alwaysOutputData: true } } as never), '', { runAgent: async () => ({ output: '' }), runAction })
  assert.equal(seen[0].retryDelayMs, 30_000)
  assert.equal(seen[0].alwaysOutputData, true)
  assert.equal(seen[1].retryDelayMs, 5_000)
  assert.equal(seen[1].alwaysOutputData, true)
})

test('an unset option is not invented', async () => {
  let config: Record<string, unknown> = {}
  await interpretFlow(chain({ id: 't', type: 'tool', data: { connectionId: 'c', toolName: 'x', args: '{}' } }), '', {
    runAgent: async () => ({ output: '' }),
    runAction: async (node) => { config = node.config; return { output: {} } },
  })
  assert.equal('retryDelayMs' in config, false)
  assert.equal('alwaysOutputData' in config, false)
})

test('the ROI data pull\'s 30s wait between tries reaches its tool step', async () => {
  const pull = ROI_DATA_PULL_DATABRICKS.graph.nodes.find((node) => node.type === 'tool' && (node.data as { retryDelayMs?: number }).retryDelayMs)
  assert.ok(pull, 'the template sets a wait between tries')
  let config: Record<string, unknown> = {}
  // The step as the template writes it, minus what binds it to earlier steps.
  const data: Record<string, unknown> = { ...(pull.data as Record<string, unknown>) }
  delete data.perItem
  await interpretFlow(chain({ ...pull, data: { ...data, args: '{}' } } as never), '', {
    runAgent: async () => ({ output: '' }),
    runAction: async (node) => { config = node.config; return { output: {} } },
  })
  assert.equal(config.retryDelayMs, 30_000)
})

test('an agent step honours Wait Between Tries', async () => {
  let calls = 0
  const runAgent = async () => (++calls < 3 ? { error: 'flaky' } : { output: 'done' })
  const started = Date.now()
  // retryDelayMs 0: both retries go immediately. The old fixed schedule waited
  // 500ms then 1000ms regardless.
  const result = await interpretFlow(chain({ id: 'a', type: 'agent', data: { agentId: 'x', input: 'go', retries: 2, retryDelayMs: 0 } }), '', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(calls, 3)
  assert.ok(Date.now() - started < 400, `retried without the fixed backoff (${Date.now() - started}ms)`)
})

test('an agent step honours Always Output Data', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: 'go', alwaysOutputData: true } },
      { id: 'b', type: 'agent', data: { agentId: 'y', input: 'after' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'a' }, { id: 'e2', source: 'a', target: 'b' }],
  }
  const outputs: Record<string, unknown> = {}
  const result = await interpretFlow(graph, '', {
    runAgent: async (node) => ({ output: node.agentId === 'x' ? '' : 'ran' }),
    onStep: (step) => { if (step.status === 'succeeded') outputs[step.nodeId] = step.output },
  })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(outputs.a, {})
  assert.equal(outputs.b, 'ran')
})

test('knowledge steps are not offered run-behaviour options their schema cannot store', () => {
  const keys = nodeOptions('knowledge').map((option) => option.key)
  for (const key of ['onError', 'retries', 'retryDelayMs', 'timeoutMs', 'alwaysOutputData']) {
    assert.equal(keys.includes(key), false, `${key} is not offered for knowledge steps`)
  }
})

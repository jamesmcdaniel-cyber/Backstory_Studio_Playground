import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunAgentFn, type RunActionFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'

// A runAgent stub that echoes a canned output per agentId (default: echoes input).
const stub =
  (map: Record<string, unknown>): RunAgentFn =>
  async (node) => ({ output: map[node.agentId] ?? `ran:${node.input}` })

test('linear flow threads output between two agent steps', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: '{{trigger.input}}' } },
      { id: 'n2', type: 'agent', data: { agentId: 'a2', input: 'got {{step.n1.output}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'n2' },
    ],
  }
  const result = await interpretFlow(graph, 'hello', { runAgent: stub({ a1: 'ONE' }) })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'ran:got ONE')
  assert.equal(result.steps.filter((s) => s.status === 'succeeded').length, 2)
})

test('webhook-triggered flow runs agent, webhook/HTTP, integration, and MCP actions end to end', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'webhook' } } },
      { id: 'agent', type: 'agent', data: { agentId: 'triage', input: 'Triage {{trigger.input.account}}' } },
      { id: 'webhook', type: 'http', data: { method: 'POST', url: 'https://hooks.example.com', bodyMode: 'json', body: '{"summary":"{{step.agent.output}}"}' } },
      { id: 'http', type: 'http', data: { method: 'GET', url: 'https://api.example.com/{{trigger.input.id}}' } },
      { id: 'integration', type: 'tool', data: { connectionId: 'native:http', toolName: 'http_request', args: '{"status":"{{step.http.output.status}}"}' } },
      { id: 'mcp', type: 'tool', data: { connectionId: 'mcp-1', toolName: 'lookup_record', args: '{"deliveryId":"{{step.integration.output.deliveryId}}"}' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'agent' },
      { id: 'e2', source: 'agent', target: 'webhook' },
      { id: 'e3', source: 'webhook', target: 'http' },
      { id: 'e4', source: 'http', target: 'integration' },
      { id: 'e5', source: 'integration', target: 'mcp' },
    ],
  }
  const calls: { id: string; kind: string; config: Record<string, unknown> }[] = []
  const runAgent: RunAgentFn = async (node) => {
    assert.equal(node.input, 'Triage Acme')
    return { output: 'qualified' }
  }
  const runAction: RunActionFn = async (node) => {
    calls.push(node)
    if (node.id === 'webhook') return { output: { accepted: true } }
    if (node.id === 'http') return { output: { status: 200 } }
    if (node.id === 'integration') return { output: { deliveryId: 'del-1' } }
    return { output: { recordId: 'rec-1' } }
  }
  const result = await interpretFlow(graph, { account: 'Acme', id: 'acct-1' }, { runAgent, runAction })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(result.output, { recordId: 'rec-1' })
  assert.deepEqual(calls.map((call) => [call.id, call.kind]), [
    ['webhook', 'http'],
    ['http', 'http'],
    ['integration', 'tool'],
    ['mcp', 'tool'],
  ])
  assert.deepEqual(calls[0].config.body, { summary: 'qualified' })
  assert.equal(calls[1].config.url, 'https://api.example.com/acct-1')
  assert.deepEqual(calls[2].config.args, { status: 200 })
  assert.deepEqual(calls[3].config.args, { deliveryId: 'del-1' })
})

test('structured trigger input fields are addressable', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: 'Account {{trigger.input.account.name}} has {{trigger.input.items.0}}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  const runAgent: RunAgentFn = async (node) => ({ output: node.input })
  const result = await interpretFlow(graph, { account: { name: 'Acme' }, items: ['A'] }, { runAgent })
  assert.equal(result.output, 'Account Acme has A')
})

test('condition routes to the true branch', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'score', input: '{{trigger.input}}' } },
      { id: 'c', type: 'condition', data: { left: '{{step.n1.output.score}}', op: 'gt', right: '80' } },
      { id: 'hi', type: 'agent', data: { agentId: 'high', input: 'x' } },
      { id: 'lo', type: 'agent', data: { agentId: 'low', input: 'x' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'c' },
      { id: 'e2', source: 'c', target: 'hi', branch: 'true' },
      { id: 'e3', source: 'c', target: 'lo', branch: 'false' },
    ],
  }
  const result = await interpretFlow(graph, 'Acme', { runAgent: stub({ score: '{"score":91}', high: 'HIGH', low: 'LOW' }) })
  assert.equal(result.output, 'HIGH')
})

test('loop fans out over an array and collects results', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'list', type: 'agent', data: { agentId: 'list', input: 'x' } },
      { id: 'loop', type: 'loop', data: { over: '{{step.list.output}}', concurrency: 2, body: ['score'] } },
      { id: 'score', type: 'agent', data: { agentId: 'score', input: 'score {{item}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'list' },
      { id: 'e1', source: 'list', target: 'loop' },
    ],
  }
  const result = await interpretFlow(graph, '', { runAgent: stub({ list: '["A","B","C"]' }) })
  // The `score` agent isn't in the stub map, so it echoes `ran:<input>`, which
  // confirms the loop resolved `score {{item}}` per item before delegating.
  assert.deepEqual(result.output, ['ran:score A', 'ran:score B', 'ran:score C'])
})

test('loop honors concurrency while preserving output order', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', concurrency: 2, body: ['echo'] } },
      { id: 'echo', type: 'agent', data: { agentId: 'echo', input: '{{item}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  let active = 0
  let maxActive = 0
  const delays: Record<string, number> = { '0': 30, '1': 5, '2': 10, '3': 1 }
  const runAgent: RunAgentFn = async (node) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, delays[node.input] ?? 1))
    active -= 1
    return { output: node.input }
  }
  const result = await interpretFlow(graph, [0, 1, 2, 3], { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(maxActive, 2)
  assert.deepEqual(result.output, ['0', '1', '2', '3'])
})

test('waiting sub-run halts the flow', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'ask', input: 'x' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'n1' }],
  }
  const runAgent: RunAgentFn = async () => ({ waiting: { status: 'waiting_for_input', question: 'Which segment?' } })
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'waiting')
  assert.equal(result.waiting?.question, 'Which segment?')
})

test('onError:stop fails the flow; onError:continue proceeds', async () => {
  const base = (onError: 'stop' | 'continue'): FlowGraph => ({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'boom', input: 'x', onError } },
      { id: 'n2', type: 'agent', data: { agentId: 'ok', input: 'y' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'n2' },
    ],
  })
  const runAgent: RunAgentFn = async (n) => (n.agentId === 'boom' ? { error: 'kaboom' } : { output: 'DONE' })
  assert.equal((await interpretFlow(base('stop'), '', { runAgent })).status, 'failed')
  assert.equal((await interpretFlow(base('continue'), '', { runAgent })).output, 'DONE')
})

test('stop node ends the flow early and skips later steps', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: 'x' } },
      { id: 's', type: 'stop', data: { reason: 'done' } },
      { id: 'n2', type: 'agent', data: { agentId: 'a2', input: 'y' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 's' },
      { id: 'e2', source: 's', target: 'n2' },
    ],
  }
  const seen: string[] = []
  const runAgent: RunAgentFn = async (n) => { seen.push(n.agentId); return { output: n.agentId } }
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(seen, ['a1']) // a2 never runs
  assert.equal(result.output, 'a1')
})

test('nested loops fan out at two levels', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'outer', type: 'loop', data: { over: '{{trigger.input}}', concurrency: 2, body: ['inner'] } },
      { id: 'inner', type: 'loop', data: { over: '{{item}}', concurrency: 2, body: ['echo'] } },
      { id: 'echo', type: 'agent', data: { agentId: 'echo', input: 'v={{item}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'outer' }],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  const result = await interpretFlow(graph, [[1, 2], [3, 4]], { runAgent })
  assert.deepEqual(result.output, [['v=1', 'v=2'], ['v=3', 'v=4']])
})

test('loop exposes {{loop.index}}', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['e'] } },
      { id: 'e', type: 'agent', data: { agentId: 'e', input: '{{loop.index}}:{{item}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  const result = await interpretFlow(graph, ['a', 'b', 'c'], { runAgent })
  assert.deepEqual(result.output, ['0:a', '1:b', '2:c'])
})

test('loop accepts comma-separated and newline-separated text input', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['e'] } },
      { id: 'e', type: 'agent', data: { agentId: 'e', input: '{{item}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  assert.deepEqual((await interpretFlow(graph, 'Acme, Globex', { runAgent })).output, ['Acme', 'Globex'])
  assert.deepEqual((await interpretFlow(graph, 'Acme\nGlobex', { runAgent })).output, ['Acme', 'Globex'])
})

test('loop accepts common object payload lists', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['e'] } },
      { id: 'e', type: 'agent', data: { agentId: 'e', input: '{{item.name}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  const result = await interpretFlow(graph, JSON.stringify({ items: [{ name: 'Acme' }, { name: 'Globex' }] }), { runAgent })
  assert.deepEqual(result.output, ['Acme', 'Globex'])
})

test('an error inside a loop item propagates and fails the flow', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['boom'] } },
      { id: 'boom', type: 'agent', data: { agentId: 'boom', input: '{{item}}', onError: 'stop' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const runAgent: RunAgentFn = async () => ({ error: 'kaboom' })
  const result = await interpretFlow(graph, ['a', 'b'], { runAgent })
  assert.equal(result.status, 'failed')
})

test('a disabled step is skipped and the prior value passes through', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: '{{trigger.input}}' } },
      { id: 'n2', type: 'agent', data: { agentId: 'a2', input: 'should not run' }, disabled: true },
      { id: 'n3', type: 'agent', data: { agentId: 'a3', input: 'saw {{step.n1.output}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ],
  }
  const ran: string[] = []
  const runAgent: RunAgentFn = async (n) => { ran.push(n.agentId); return { output: n.input } }
  const result = await interpretFlow(graph, 'X', { runAgent: async (n) => { ran.push(n.agentId); return { output: n.agentId === 'a1' ? 'ONE' : n.input } } })
  void runAgent
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(ran, ['a1', 'a3']) // a2 (disabled) never ran
  assert.equal(result.output, 'saw ONE') // n3 still saw n1's output past the disabled step
  assert.equal(result.steps.find((s) => s.nodeId === 'n2')?.status, 'skipped')
})

// ── Per-item fan-out (list-aware step contract) + per-item error policy ──────

test('perItem fans a single tool step out over a list and collects outputs in order', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 't1', type: 'tool', data: { connectionId: 'c1', toolName: 'enrich', args: '{"name":"{{item.name}}"}', perItem: { over: '{{trigger.input}}' } } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 't1' }],
  }
  const seen: unknown[] = []
  const runAction: RunActionFn = async (node) => {
    const args = node.config.args as { name: string }
    seen.push(args)
    return { output: `enriched:${args.name}` }
  }
  const result = await interpretFlow(graph, [{ name: 'Acme' }, { name: 'Globex' }], { runAgent: async () => ({ output: 'unused' }), runAction })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(seen, [{ name: 'Acme' }, { name: 'Globex' }]) // one call per item, item resolved
  assert.deepEqual(result.output, ['enriched:Acme', 'enriched:Globex']) // outputs collected into a list
})

test('perItem itemError:skip drops failing items and keeps the survivors', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 't1', type: 'tool', data: { connectionId: 'c1', toolName: 'enrich', args: '{"n":"{{item}}"}', perItem: { over: '{{trigger.input}}', itemError: 'skip' } } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 't1' }],
  }
  const runAction: RunActionFn = async (node) => {
    const n = (node.config.args as { n: string }).n
    return n === 'B' ? { error: 'bad B' } : { output: `ok:${n}` }
  }
  const result = await interpretFlow(graph, ['A', 'B', 'C'], { runAgent: async () => ({ output: '' }), runAction })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(result.output, ['ok:A', 'ok:C']) // B failed and was dropped
})

test('perItem itemError:collect keeps a {error} placeholder in the failed slot', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 't1', type: 'tool', data: { connectionId: 'c1', toolName: 'enrich', args: '{"n":"{{item}}"}', perItem: { over: '{{trigger.input}}', itemError: 'collect' } } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 't1' }],
  }
  const runAction: RunActionFn = async (node) => {
    const n = (node.config.args as { n: string }).n
    return n === 'B' ? { error: 'bad B' } : { output: `ok:${n}` }
  }
  const result = await interpretFlow(graph, ['A', 'B', 'C'], { runAgent: async () => ({ output: '' }), runAction })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(result.output, ['ok:A', { error: 'bad B' }, 'ok:C'])
})

test('perItem itemError:fail (default) fails the whole step on the first failing item', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 't1', type: 'tool', data: { connectionId: 'c1', toolName: 'enrich', args: '{"n":"{{item}}"}', perItem: { over: '{{trigger.input}}' } } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 't1' }],
  }
  const runAction: RunActionFn = async (node) => ((node.config.args as { n: string }).n === 'B' ? { error: 'bad B' } : { output: 'ok' })
  const result = await interpretFlow(graph, ['A', 'B', 'C'], { runAgent: async () => ({ output: '' }), runAction })
  assert.equal(result.status, 'failed')
})

test('perItem reports one step outcome per item plus a step summary', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a1', type: 'ai', data: { aiOp: 'summarize', input: '{{item}}', perItem: { over: '{{trigger.input}}' } } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'a1' }],
  }
  const runAction: RunActionFn = async (node) => ({ output: `sum:${node.config.input}` })
  const outcomes: { nodeId: string; iterationKey?: string }[] = []
  const result = await interpretFlow(graph, ['x', 'y'], {
    runAgent: async () => ({ output: '' }),
    runAction,
    onStep: (o) => outcomes.push({ nodeId: o.nodeId, iterationKey: o.iterationKey }),
  })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(result.output, ['sum:x', 'sum:y'])
  // Two per-item rows keyed a1#0 / a1#1, plus the bare-a1 summary row.
  assert.deepEqual(outcomes.filter((o) => o.iterationKey === 'a1#0').length, 1)
  assert.deepEqual(outcomes.filter((o) => o.iterationKey === 'a1#1').length, 1)
  assert.deepEqual(outcomes.filter((o) => o.iterationKey === 'a1').length, 1)
})

test('perItem over an empty list succeeds with an empty output list', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 't1', type: 'tool', data: { connectionId: 'c1', toolName: 'x', args: '{}', perItem: { over: '{{trigger.input}}' } } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 't1' }],
  }
  let calls = 0
  const runAction: RunActionFn = async () => { calls += 1; return { output: 'ok' } }
  const result = await interpretFlow(graph, [], { runAgent: async () => ({ output: '' }), runAction })
  assert.equal(result.status, 'succeeded')
  assert.equal(calls, 0)
  assert.deepEqual(result.output, [])
})

test('loop itemError:skip drops failing iterations and keeps the rest', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', itemError: 'skip', body: ['a'] } },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: '{{item}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const runAgent: RunAgentFn = async (n) => (n.input === 'B' ? { error: 'bad' } : { output: n.input })
  const result = await interpretFlow(graph, ['A', 'B', 'C'], { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(result.output, ['A', 'C'])
})

test('loop itemError:collect keeps {error} placeholders for failing iterations', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', itemError: 'collect', body: ['a'] } },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: '{{item}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const runAgent: RunAgentFn = async (n) => (n.input === 'B' ? { error: 'bad' } : { output: n.input })
  const result = await interpretFlow(graph, ['A', 'B', 'C'], { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(result.output, ['A', { error: 'bad' }, 'C'])
})

test('multi-criteria condition (AND) routes correctly', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'score', input: 'x' } },
      {
        id: 'c',
        type: 'condition',
        data: {
          match: 'all',
          clauses: [
            { left: '{{step.n1.output.score}}', op: 'gt', right: '80' },
            { left: '{{trigger.input}}', op: 'contains', right: 'Acme' },
          ],
        },
      },
      { id: 'hi', type: 'agent', data: { agentId: 'high', input: 'x' } },
      { id: 'lo', type: 'agent', data: { agentId: 'low', input: 'x' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'c' },
      { id: 'e2', source: 'c', target: 'hi', branch: 'true' },
      { id: 'e3', source: 'c', target: 'lo', branch: 'false' },
    ],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.agentId === 'score' ? '{"score":91}' : n.agentId.toUpperCase() })
  const result = await interpretFlow(graph, 'Acme Corp', { runAgent })
  assert.equal(result.output, 'HIGH')
})

test('resume skips completed nodes and re-runs the paused one', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: 'x' } },
      { id: 'n2', type: 'agent', data: { agentId: 'ask', input: 'y' } },
      { id: 'n3', type: 'agent', data: { agentId: 'a3', input: 'got {{step.n2.output}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ],
  }
  const ran: string[] = []
  const runAgent: RunAgentFn = async (n) => {
    ran.push(n.id)
    if (n.id === 'n2') return { output: n.resume ? 'ANSWERED' : 'ignored' }
    return { output: n.input }
  }
  // Resume: n1 already completed (skipped), n2 is the paused node (re-runs w/ reply).
  const result = await interpretFlow(graph, '', {
    runAgent,
    completed: { n1: 'a1' },
    resumeNodeId: 'n2',
  })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(ran, ['n2', 'n3']) // n1 was skipped, not re-run
  assert.equal(result.output, 'got ANSWERED') // n3 saw the resumed n2 output
})

test('tool and http steps resolve templates and thread output', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 't1', type: 'tool', data: { connectionId: 'c1', toolName: 'lookup', args: '{"account":"{{trigger.input}}"}' } },
      { id: 'h1', type: 'http', data: { method: 'POST', url: 'https://example.com/hook', body: 'got {{step.t1.output.score}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 't1' },
      { id: 'e1', source: 't1', target: 'h1' },
    ],
  }
  const calls: Record<string, unknown>[] = []
  const runAction: RunActionFn = async (node) => {
    calls.push({ kind: node.kind, ...node.config })
    return node.kind === 'tool' ? { output: '{"score":88}' } : { output: `sent:${node.config.body}` }
  }
  const runAgent: RunAgentFn = async () => ({ output: 'unused' })
  const result = await interpretFlow(graph, 'Acme', { runAgent, runAction })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(calls[0].args, { account: 'Acme' }) // template resolved into tool args
  assert.equal(result.output, 'sent:got 88') // http body saw the tool's structured output
})

test('http steps preserve structured query, headers, and body values', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      {
        id: 'h1',
        type: 'http',
        data: {
          method: 'POST',
          url: 'https://example.com/accounts/{{trigger.input.accountId}}',
          query: '{"tags": "{{trigger.input.tags}}", "active": "{{trigger.input.active}}"}',
          headers: '{"authorization": "Bearer {{trigger.input.token}}"}',
          bodyMode: 'json',
          responseType: 'json',
          failOnHttpError: false,
          retries: 2,
          timeoutMs: 15000,
          body: '{"record": "{{trigger.input.record}}"}',
        },
      },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'h1' }],
  }
  const calls: Record<string, unknown>[] = []
  const runAction: RunActionFn = async (node) => {
    calls.push(node.config)
    return { output: { ok: true } }
  }
  const input = { accountId: 'acct_1', tags: ['a', 'b'], active: true, token: 'tok', record: { name: 'Acme' } }
  const result = await interpretFlow(graph, input, { runAgent: async () => ({ output: 'unused' }), runAction })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(calls[0], {
    method: 'POST',
    url: 'https://example.com/accounts/acct_1',
    query: { tags: ['a', 'b'], active: true },
    headers: { authorization: 'Bearer tok' },
    body: { record: { name: 'Acme' } },
    bodyMode: 'json',
    responseType: 'json',
    failOnHttpError: false,
    retries: 2,
    timeoutMs: 15000,
  })
})

test('http pagination and optimize-for-AI statics pass through to the adapter', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      {
        id: 'h1',
        type: 'http',
        data: {
          method: 'GET',
          url: 'https://example.com/api',
          pagination: { mode: 'updateParam', param: 'page', start: 1, maxPages: 3, itemsPath: 'data' },
          optimizeForAi: { dataPath: 'data', fields: ['id', 'name'], maxItems: 50 },
        },
      },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'h1' }],
  }
  const calls: Record<string, unknown>[] = []
  const runAction: RunActionFn = async (node) => {
    calls.push(node.config)
    return { output: { ok: true } }
  }
  const result = await interpretFlow(graph, '', { runAgent: async () => ({ output: '' }), runAction })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(calls[0].pagination, { mode: 'updateParam', param: 'page', start: 1, maxPages: 3, itemsPath: 'data' })
  assert.deepEqual(calls[0].optimizeForAi, { dataPath: 'data', fields: ['id', 'name'], maxItems: 50 })
})

test('tool args preserve object values from loop items', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['tool'] } },
      { id: 'tool', type: 'tool', data: { connectionId: 'c1', toolName: 'send', args: '{"account": "{{item}}", "name": "{{item.name}}"}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const calls: Record<string, unknown>[] = []
  const runAction: RunActionFn = async (node) => {
    calls.push(node.config)
    return { output: 'ok' }
  }
  const runAgent: RunAgentFn = async () => ({ output: 'unused' })
  const input = JSON.stringify([{ name: 'Acme', score: 91 }])
  const result = await interpretFlow(graph, input, { runAgent, runAction })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(calls[0].args, { account: { name: 'Acme', score: 91 }, name: 'Acme' })
})

test('tool steps pass retry and timeout config to the action runtime', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      {
        id: 'tool',
        type: 'tool',
        data: {
          connectionId: 'c1',
          toolName: 'send',
          retries: 2,
          timeoutMs: 15000,
          args: '{"message":"{{trigger.input.message}}"}',
        },
      },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'tool' }],
  }
  const calls: Record<string, unknown>[] = []
  const result = await interpretFlow(graph, { message: 'hello' }, {
    runAgent: async () => ({ output: '' }),
    runAction: async (node) => {
      calls.push(node.config)
      return { output: { ok: true } }
    },
  })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(calls[0], {
    connectionId: 'c1',
    toolName: 'send',
    args: { message: 'hello' },
    retries: 2,
    timeoutMs: 15000,
  })
})

test('a failing tool step honors onError', async () => {
  const graph = (onError: 'stop' | 'continue'): FlowGraph => ({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 't1', type: 'tool', data: { connectionId: 'c1', toolName: 'boom', onError } },
      { id: 'a1', type: 'agent', data: { agentId: 'ok', input: 'x' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 't1' },
      { id: 'e1', source: 't1', target: 'a1' },
    ],
  })
  const runAction: RunActionFn = async () => ({ error: 'tool exploded' })
  const runAgent: RunAgentFn = async () => ({ output: 'OK' })
  assert.equal((await interpretFlow(graph('stop'), '', { runAgent, runAction })).status, 'failed')
  assert.equal((await interpretFlow(graph('continue'), '', { runAgent, runAction })).output, 'OK')
})

test('onError:route sends a failed tool step down its labeled error edge (Error Shield)', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 't1', type: 'tool', data: { connectionId: 'c1', toolName: 'boom', args: '{"who":"{{trigger.input}}"}', onError: 'route' } },
      { id: 'handle', type: 'agent', data: { agentId: 'log', input: 'failed: {{step.t1.output.error}} for {{step.t1.output.input.args.who}}' } },
      { id: 'happy', type: 'agent', data: { agentId: 'happy', input: 'should not run' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 't1' },
      { id: 'e1', source: 't1', target: 'happy' }, // normal (success) edge
      { id: 'e2', source: 't1', target: 'handle', branch: 'error' }, // labeled error edge
    ],
  }
  const runAction: RunActionFn = async () => ({ error: 'tool exploded' })
  const seen: string[] = []
  const runAgent: RunAgentFn = async (n) => { seen.push(n.agentId); return { output: n.input } }
  const result = await interpretFlow(graph, 'Acme', { runAgent, runAction })
  assert.equal(result.status, 'succeeded')
  // Only the error-branch handler ran; the success branch (`happy`) was skipped.
  assert.deepEqual(seen, ['log'])
  // The handler read the error message AND the passed-through resolved input.
  assert.equal(result.output, 'failed: tool exploded for Acme')
})

test('onError:route without an error edge falls through to the normal edge (continue-like)', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 't1', type: 'tool', data: { connectionId: 'c1', toolName: 'boom', onError: 'route' } },
      { id: 'next', type: 'agent', data: { agentId: 'next', input: 'saw {{step.t1.output.error}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 't1' },
      { id: 'e1', source: 't1', target: 'next' }, // only a normal edge — no error path
    ],
  }
  const runAction: RunActionFn = async () => ({ error: 'tool exploded' })
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  const result = await interpretFlow(graph, '', { runAgent, runAction })
  assert.equal(result.status, 'succeeded')
  // No crash, no dead-end: the walk continues down the normal edge and the
  // error object is still readable as the failed step's output.
  assert.equal(result.output, 'saw tool exploded')
})

test('onError:route on an agent step routes its failure down the error edge', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a1', type: 'agent', data: { agentId: 'boom', input: 'work on {{trigger.input}}', onError: 'route' } },
      { id: 'handle', type: 'agent', data: { agentId: 'log', input: 'recover {{step.a1.output.error}} :: {{step.a1.output.input}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'a1' },
      { id: 'e1', source: 'a1', target: 'handle', branch: 'error' },
    ],
  }
  const runAgent: RunAgentFn = async (n) => (n.agentId === 'boom' ? { error: 'agent kaboom' } : { output: n.input })
  const result = await interpretFlow(graph, 'X', { runAgent })
  assert.equal(result.status, 'succeeded')
  // The error message and the resolved prompt string both passed through.
  assert.equal(result.output, 'recover agent kaboom :: work on X')
})

// ── AI steps: routed through the action adapter (kind 'ai'), same envelope
// as tool/http (retries/timeoutMs pass through unenforced here; onError
// stop/continue/route dispatch identically) ─────────────────────────────────

test('ai step resolves input/instructions templates and passes untouched statics through to the adapter', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      {
        id: 'a1',
        type: 'ai',
        data: {
          aiOp: 'categorize',
          input: 'Ticket: {{trigger.input}}',
          instructions: 'Pick the best fit for {{trigger.input}}',
          model: 'smart',
          categories: ['billing', 'bug', '{{trigger.input}}'],
          outputFields: [{ name: 'category', type: 'string' }],
          scoreMin: 1,
          scoreMax: 5,
          onError: 'stop',
          retries: 2,
          timeoutMs: 9000,
        },
      },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'a1' }],
  }
  const calls: Record<string, unknown>[] = []
  const runAction: RunActionFn = async (node) => {
    calls.push({ kind: node.kind, ...node.config })
    return { output: 'ok' }
  }
  const result = await interpretFlow(graph, 'Acme', { runAgent: async () => ({ output: 'unused' }), runAction })
  assert.equal(result.status, 'succeeded')
  assert.equal(calls[0].kind, 'ai')
  assert.equal(calls[0].input, 'Ticket: Acme') // {{trigger.input}} resolved
  assert.equal(calls[0].instructions, 'Pick the best fit for Acme') // resolved
  // Statics pass through UNresolved — categories keeps its literal {{token}} text.
  assert.deepEqual(calls[0].categories, ['billing', 'bug', '{{trigger.input}}'])
  assert.equal(calls[0].aiOp, 'categorize')
  assert.equal(calls[0].model, 'smart')
  assert.deepEqual(calls[0].outputFields, [{ name: 'category', type: 'string' }])
  assert.equal(calls[0].scoreMin, 1)
  assert.equal(calls[0].scoreMax, 5)
  assert.equal(calls[0].retries, 2)
  assert.equal(calls[0].timeoutMs, 9000)
})

test('ai step handles blank/missing input and instructions without crashing', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a1', type: 'ai', data: { aiOp: 'summarize' } }, // no input, no instructions configured
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'a1' }],
  }
  const calls: Record<string, unknown>[] = []
  const runAction: RunActionFn = async (node) => {
    calls.push(node.config)
    return { output: 'summary text' }
  }
  const result = await interpretFlow(graph, 'ignored', { runAgent: async () => ({ output: 'unused' }), runAction })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'summary text')
  assert.equal(calls[0].input, undefined)
  assert.equal(calls[0].instructions, undefined)
})

test('ai step output threads through as a structured object for downstream steps', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a1', type: 'ai', data: { aiOp: 'categorize', input: '{{trigger.input}}', categories: ['billing', 'bug'] } },
      { id: 'n2', type: 'agent', data: { agentId: 'log', input: 'category={{step.a1.output.category}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'a1' },
      { id: 'e1', source: 'a1', target: 'n2' },
    ],
  }
  // The adapter's reply arrives as a JSON string (mirrors a real structured
  // model response) — asStructured must parse it before it threads onward.
  const runAction: RunActionFn = async () => ({ output: '{"category":"billing"}' })
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  const result = await interpretFlow(graph, 'my invoice is wrong', { runAgent, runAction })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'category=billing')
})

test('a failing ai step honors onError', async () => {
  const graph = (onError: 'stop' | 'continue'): FlowGraph => ({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a1', type: 'ai', data: { aiOp: 'ask', input: 'x', onError } },
      { id: 'n2', type: 'agent', data: { agentId: 'ok', input: 'y' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'a1' },
      { id: 'e1', source: 'a1', target: 'n2' },
    ],
  })
  const runAction: RunActionFn = async () => ({ error: 'model exploded' })
  const runAgent: RunAgentFn = async () => ({ output: 'OK' })
  assert.equal((await interpretFlow(graph('stop'), '', { runAgent, runAction })).status, 'failed')
  assert.equal((await interpretFlow(graph('continue'), '', { runAgent, runAction })).output, 'OK')
})

test('onError:route sends a failed ai step down its labeled error edge (Error Shield)', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a1', type: 'ai', data: { aiOp: 'ask', input: 'work on {{trigger.input}}', onError: 'route' } },
      { id: 'handle', type: 'agent', data: { agentId: 'log', input: 'failed: {{step.a1.output.error}} for {{step.a1.output.input.input}}' } },
      { id: 'happy', type: 'agent', data: { agentId: 'happy', input: 'should not run' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'a1' },
      { id: 'e1', source: 'a1', target: 'happy' }, // normal (success) edge
      { id: 'e2', source: 'a1', target: 'handle', branch: 'error' }, // labeled error edge
    ],
  }
  const runAction: RunActionFn = async () => ({ error: 'model exploded' })
  const seen: string[] = []
  const runAgent: RunAgentFn = async (n) => { seen.push(n.agentId); return { output: n.input } }
  const result = await interpretFlow(graph, 'Acme', { runAgent, runAction })
  assert.equal(result.status, 'succeeded')
  // Only the error-branch handler ran; the success branch ('happy') was skipped.
  assert.deepEqual(seen, ['log'])
  // The handler read the error message AND the passed-through resolved input.
  assert.equal(result.output, 'failed: model exploded for work on Acme')
})

test('onError:route on an ai step without an error edge falls through to the normal edge (continue-like)', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a1', type: 'ai', data: { aiOp: 'ask', input: 'x', onError: 'route' } },
      { id: 'next', type: 'agent', data: { agentId: 'next', input: 'saw {{step.a1.output.error}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'a1' },
      { id: 'e1', source: 'a1', target: 'next' }, // only a normal edge — no error path
    ],
  }
  const runAction: RunActionFn = async () => ({ error: 'model exploded' })
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  const result = await interpretFlow(graph, '', { runAgent, runAction })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'saw model exploded')
})

// Interpreter-level retry/timeout policy for 'ai' mirrors tool/http EXACTLY:
// there is none at this seam. `retries`/`timeoutMs` ride through in `config`
// unchanged (asserted above); the interpreter calls the adapter exactly ONCE
// per step regardless of `retries` — enforcement (including the WS9 T5
// TIMED_OUT-sentinel no-retry-on-timeout rule) is the adapter's job (Task 3),
// exactly as it already is for 'tool' (see execute-flow.ts's runWithRetries +
// shouldRetryAfterTimeout — interpret.ts itself never wraps 'tool' in a retry
// loop either; runAgentWithReliability above is 'agent'-only).
test('a failing ai step is NOT retried by the interpreter — retries/timeout enforcement belongs to the adapter, like tool/http', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a1', type: 'ai', data: { aiOp: 'ask', input: '{{trigger.input}}', retries: 1, timeoutMs: 9000 } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'a1' }],
  }
  let calls = 0
  const configs: Record<string, unknown>[] = []
  const runAction: RunActionFn = async (node) => {
    calls += 1
    configs.push(node.config)
    return { error: 'model unavailable' } // fails on the interpreter's one and only call
  }
  const result = await interpretFlow(graph, 'hi', { runAgent: async () => ({ output: 'unused' }), runAction })
  assert.equal(result.status, 'failed')
  assert.equal(calls, 1) // retries: 1 does NOT make the interpreter re-call the adapter
  assert.equal(configs[0].retries, 1)
  assert.equal(configs[0].timeoutMs, 9000)
})

test('transform builds an object from templated fields', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a', input: 'x' } },
      { id: 'set', type: 'transform', data: { fields: [{ name: 'account', value: '{{trigger.input}}' }, { name: 'score', value: '{{step.n1.output.score}}' }] } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'n1' }, { id: 'e1', source: 'n1', target: 'set' }],
  }
  const runAgent: RunAgentFn = async () => ({ output: '{"score":91}' })
  const result = await interpretFlow(graph, 'Acme', { runAgent })
  assert.deepEqual(result.output, { account: 'Acme', score: 91 })
})

test('filter drops loop items that fail and ends the chain when it fails', async () => {
  const loopGraph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['keep', 'echo'] } },
      { id: 'keep', type: 'filter', data: { clauses: [{ left: '{{item.score}}', op: 'gt', right: '80' }] } },
      { id: 'echo', type: 'agent', data: { agentId: 'e', input: '{{item.name}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  const items = [{ name: 'A', score: 91 }, { name: 'B', score: 40 }, { name: 'C', score: 88 }]
  const result = await interpretFlow(loopGraph, items, { runAgent })
  assert.deepEqual(result.output, ['A', 'C']) // B (score 40) filtered out
})

test('switch routes to the matching case, else default', async () => {
  const graph = (_tier: string): FlowGraph => ({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'sw', type: 'switch', data: { cases: [{ id: 'ent', left: '{{trigger.input}}', op: 'eq', right: 'enterprise' }, { id: 'mid', left: '{{trigger.input}}', op: 'eq', right: 'mid' }] } },
      { id: 'e', type: 'agent', data: { agentId: 'ent', input: 'ENT' } },
      { id: 'm', type: 'agent', data: { agentId: 'mid', input: 'MID' } },
      { id: 'd', type: 'agent', data: { agentId: 'def', input: 'DEFAULT' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'sw' },
      { id: 'e1', source: 'sw', target: 'e', branch: 'ent' },
      { id: 'e2', source: 'sw', target: 'm', branch: 'mid' },
      { id: 'e3', source: 'sw', target: 'd', branch: 'default' },
    ],
  })
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  assert.equal((await interpretFlow(graph('enterprise'), 'enterprise', { runAgent })).output, 'ENT')
  assert.equal((await interpretFlow(graph('mid'), 'mid', { runAgent })).output, 'MID')
  assert.equal((await interpretFlow(graph('smb'), 'smb', { runAgent })).output, 'DEFAULT')
})

// ── Join node: branches reconverge into one path ─────────────────────────────

// A condition whose true/false branches both point at ONE join, then a
// downstream agent that reads the join's output. The stub map decides which
// branch runs; `after` is NOT in the map, so it echoes `ran:<resolved input>`,
// proving it read {{step.j.output}} (the value from whichever path ran).
const conditionJoinGraph: FlowGraph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: {} },
    { id: 'n1', type: 'agent', data: { agentId: 'score', input: '{{trigger.input}}' } },
    { id: 'c', type: 'condition', data: { left: '{{step.n1.output.score}}', op: 'gt', right: '80' } },
    { id: 'hi', type: 'agent', data: { agentId: 'high', input: 'x' } },
    { id: 'lo', type: 'agent', data: { agentId: 'low', input: 'x' } },
    { id: 'j', type: 'join', data: {} },
    { id: 'after', type: 'agent', data: { agentId: 'after', input: 'saw {{step.j.output}}' } },
  ],
  edges: [
    { id: 'e0', source: 'trigger', target: 'n1' },
    { id: 'e1', source: 'n1', target: 'c' },
    { id: 'e2', source: 'c', target: 'hi', branch: 'true' },
    { id: 'e3', source: 'c', target: 'lo', branch: 'false' },
    { id: 'e4', source: 'hi', target: 'j' },
    { id: 'e5', source: 'lo', target: 'j' },
    { id: 'e6', source: 'j', target: 'after' },
  ],
}

test('condition true-branch merges into a join whose output is the branch value', async () => {
  const result = await interpretFlow(conditionJoinGraph, 'Acme', { runAgent: stub({ score: '{"score":91}', high: 'HIGH', low: 'LOW' }) })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.steps.find((s) => s.nodeId === 'j')?.output, 'HIGH') // join forwarded the true branch's value
  assert.equal(result.output, 'ran:saw HIGH') // the downstream step read {{step.j.output}}
})

test('condition false-branch merges into the same join (symmetric)', async () => {
  const result = await interpretFlow(conditionJoinGraph, 'Acme', { runAgent: stub({ score: '{"score":40}', high: 'HIGH', low: 'LOW' }) })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.steps.find((s) => s.nodeId === 'j')?.output, 'LOW')
  assert.equal(result.output, 'ran:saw LOW')
})

test('a matched switch case merges into a join', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'sw', type: 'switch', data: { cases: [{ id: 'ent', left: '{{trigger.input}}', op: 'eq', right: 'enterprise' }, { id: 'mid', left: '{{trigger.input}}', op: 'eq', right: 'mid' }] } },
      { id: 'e', type: 'agent', data: { agentId: 'ent', input: 'ENT' } },
      { id: 'm', type: 'agent', data: { agentId: 'mid', input: 'MID' } },
      { id: 'd', type: 'agent', data: { agentId: 'def', input: 'DEFAULT' } },
      { id: 'j', type: 'join', data: {} },
      { id: 'after', type: 'agent', data: { agentId: 'after', input: 'saw {{step.j.output}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'sw' },
      { id: 'e1', source: 'sw', target: 'e', branch: 'ent' },
      { id: 'e2', source: 'sw', target: 'm', branch: 'mid' },
      { id: 'e3', source: 'sw', target: 'd', branch: 'default' },
      { id: 'e4', source: 'e', target: 'j' },
      { id: 'e5', source: 'm', target: 'j' },
      { id: 'e6', source: 'd', target: 'j' },
      { id: 'e7', source: 'j', target: 'after' },
    ],
  }
  const result = await interpretFlow(graph, 'mid', { runAgent: stub({ ent: 'ENT', mid: 'MID', def: 'DEFAULT' }) })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.steps.find((s) => s.nodeId === 'j')?.output, 'MID') // forwarded the matched case's value
  assert.equal(result.output, 'ran:saw MID')
})

// ── Wait node ────────────────────────────────────────────────────────────────

const RUN_NOW = { iso: '2026-07-27T12:00:00.000Z', date: '2026-07-27', time: '12:00', unix: Math.floor(Date.parse('2026-07-27T12:00:00.000Z') / 1000) }

test('a duration wait pauses the run and reports when to resume', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'w', type: 'wait', data: { mode: 'duration', amount: '3', unit: 'days' } },
      { id: 'after', type: 'agent', data: { agentId: 'a', input: 'x' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'w' },
      { id: 'e1', source: 'w', target: 'after' },
    ],
  }
  const result = await interpretFlow(graph, '', { runAgent: stub({}), now: RUN_NOW })
  assert.equal(result.status, 'waiting')
  assert.equal(result.waiting?.nodeId, 'w')
  assert.equal(result.waiting?.waitKind, 'timer')
  assert.equal(result.waiting?.resumeAt, '2026-07-30T12:00:00.000Z') // now + 3 days
})

test('a webhook wait pauses waiting for a callback', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'w', type: 'wait', data: { mode: 'webhook' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'w' }],
  }
  const result = await interpretFlow(graph, '', { runAgent: stub({}), now: RUN_NOW })
  assert.equal(result.status, 'waiting')
  assert.equal(result.waiting?.waitKind, 'webhook')
  assert.equal(result.waiting?.resumeAt, undefined) // no safety timeout set
})

test('resuming a wait node threads the callback body and continues', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'w', type: 'wait', data: { mode: 'webhook' } },
      { id: 'after', type: 'agent', data: { agentId: 'a', input: 'signed by {{step.w.output.signer}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'w' },
      { id: 'e1', source: 'w', target: 'after' },
    ],
  }
  const result = await interpretFlow(graph, '', {
    runAgent: async (n) => ({ output: n.input }),
    completed: {},
    resumeNodeId: 'w',
    resumeReply: '{"signer":"Dana"}',
  })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'signed by Dana')
})

test('a duration wait with a broken amount fails clearly', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'w', type: 'wait', data: { mode: 'duration', amount: '{{trigger.input.days}}', unit: 'days' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'w' }],
  }
  const result = await interpretFlow(graph, { days: 'lots' }, { runAgent: stub({}), now: RUN_NOW })
  assert.equal(result.status, 'failed')
})

test('join mode:append concatenates two independent branch outputs into one list', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'a', input: 'x' } },
      { id: 'b', type: 'agent', data: { agentId: 'b', input: 'y' } },
      { id: 'j', type: 'join', data: { mode: 'append' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'a' },
      { id: 'e1', source: 'trigger', target: 'b' },
      { id: 'e2', source: 'a', target: 'j' },
      { id: 'e3', source: 'b', target: 'j' },
    ],
  }
  const result = await interpretFlow(graph, '', { runAgent: stub({ a: '["a1","a2"]', b: '["b1"]' }) })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(result.steps.find((s) => s.nodeId === 'j')?.output, ['a1', 'a2', 'b1'])
})

test('join mode:combineByKey full-outer-joins record lists from two branches', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'sf', type: 'agent', data: { agentId: 'sf', input: 'x' } },
      { id: 'hs', type: 'agent', data: { agentId: 'hs', input: 'y' } },
      { id: 'j', type: 'join', data: { mode: 'combineByKey', key: 'email' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'sf' },
      { id: 'e1', source: 'trigger', target: 'hs' },
      { id: 'e2', source: 'sf', target: 'j' },
      { id: 'e3', source: 'hs', target: 'j' },
    ],
  }
  const result = await interpretFlow(graph, '', {
    runAgent: stub({
      sf: '[{"email":"x@a.com","name":"X"}]',
      hs: '[{"email":"x@a.com","phone":"111"},{"email":"z@a.com","phone":"999"}]',
    }),
  })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(result.steps.find((s) => s.nodeId === 'j')?.output, [
    { email: 'x@a.com', name: 'X', phone: '111' },
    { email: 'z@a.com', phone: '999' },
  ])
})

test('join with no mode still passes through the single active branch (back-compat)', async () => {
  const result = await interpretFlow(conditionJoinGraph, 'Acme', { runAgent: stub({ score: '{"score":91}', high: 'HIGH', low: 'LOW' }) })
  assert.equal(result.steps.find((s) => s.nodeId === 'j')?.output, 'HIGH')
})

test('onStep reports every node including containers', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['e'] } },
      { id: 'e', type: 'agent', data: { agentId: 'e', input: '{{item}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const outcomes: string[] = []
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  await interpretFlow(graph, ['a', 'b'], { runAgent, onStep: (o) => outcomes.push(o.nodeId) })
  assert.ok(outcomes.includes('loop')) // the container itself is reported
  assert.equal(outcomes.filter((id) => id === 'e').length, 2) // one per item
})

test('structured agent steps append the JSON instruction and expose parsed fields', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      {
        id: 'n1',
        type: 'agent',
        data: {
          agentId: 'a1',
          input: 'Score this account',
          responseFormat: 'structured',
          outputFields: [{ name: 'score', type: 'number' }],
        },
      },
      { id: 'n2', type: 'transform', data: { fields: [{ name: 'finalScore', value: '{{step.n1.output.score}}' }] } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'n1' },
      { id: 'e2', source: 'n1', target: 'n2' },
    ],
  }
  let sentInput = ''
  const runAgent: RunAgentFn = async (node) => {
    sentInput = node.input
    return { output: '{"score": 91}' }
  }
  const result = await interpretFlow(graph, 'acme', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.match(sentInput, /JSON object/)
  assert.match(sentInput, /"score"/)
  assert.deepEqual(result.output, { finalScore: 91 })
})

test('structured agent steps fail when the reply is not the required JSON', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      {
        id: 'n1',
        type: 'agent',
        data: { agentId: 'a1', responseFormat: 'structured', outputFields: [{ name: 'score', type: 'number' }] },
      },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  const runAgent: RunAgentFn = async () => ({ output: 'no json here' })
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'failed')
  const step = result.steps.find((s) => s.nodeId === 'n1')
  assert.equal(step?.status, 'failed')
  assert.match(step?.error ?? '', /JSON/)
})

test('humanAssistance=false turns a waiting agent into a failed step', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', humanAssistance: false } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  const runAgent: RunAgentFn = async () => ({ waiting: { status: 'waiting_user', question: 'Which region?' } })
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'failed')
  assert.equal(result.steps.find((s) => s.nodeId === 'n1')?.status, 'failed')
})

test('humanAssistance defaults to allowing the pause', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  const runAgent: RunAgentFn = async () => ({ waiting: { status: 'waiting_user', question: 'Which region?' } })
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'waiting')
  assert.equal(result.waiting?.nodeId, 'n1')
})

test('an agent timeout fails the step without starting a second concurrent execution', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: 'x', retries: 3, timeoutMs: 1000 } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  let calls = 0
  // Never resolves: simulates a live execution that outruns the step timeout.
  const runAgent: RunAgentFn = async () => {
    calls += 1
    return new Promise(() => {})
  }
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'failed')
  assert.equal(calls, 1) // retries: 3 must NOT re-run the still-live agent
  const step = result.steps.find((s) => s.nodeId === 'n1')
  assert.equal(step?.status, 'failed')
  assert.match(step?.error ?? '', /Timed out after 1s — the agent may still be finishing in the background\./)
  // The run-level result carries the same message so callers can persist it
  // on the run record (FlowRun.error) — it must not live only in the step.
  assert.match(result.error ?? '', /Timed out after 1s — the agent may still be finishing in the background\./)
})

test('a failed result carries the failing step error at the run level', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: 'x' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  const runAgent: RunAgentFn = async () => ({ error: 'boom' })
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'failed')
  assert.equal(result.error, 'boom')
})

test('agent hard errors still retry up to the configured budget', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: 'x', retries: 1, timeoutMs: 30000 } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  let calls = 0
  const runAgent: RunAgentFn = async () => {
    calls += 1
    return calls < 2 ? { error: 'boom' } : { output: 'recovered' }
  }
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(calls, 2)
  assert.equal(result.output, 'recovered')
})

// ── Variables: a typed symbol table threaded through the run ──────────────

test('variable initialize + set + read across steps', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'greeting', varType: 'string', value: 'hello' } },
      { id: 'v2', type: 'variable', data: { op: 'set', name: 'greeting', value: 'hi {{trigger.input}}' } },
      { id: 'n1', type: 'agent', data: { agentId: 'e', input: '{{var.greeting}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
      { id: 'e2', source: 'v2', target: 'n1' },
    ],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  const result = await interpretFlow(graph, 'Acme', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'hi Acme') // the agent read {{var.greeting}} after set
  // Step output mirrors the new variable value, so {{step.<id>.output}} works too.
  assert.equal(result.steps.find((s) => s.nodeId === 'v1')?.output, 'hello')
  assert.equal(result.steps.find((s) => s.nodeId === 'v2')?.output, 'hi Acme')
})

test('variable increment defaults to 1 and honors an explicit amount', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'count', varType: 'integer', value: '10' } },
      { id: 'v2', type: 'variable', data: { op: 'increment', name: 'count' } },
      { id: 'v3', type: 'variable', data: { op: 'increment', name: 'count', value: '5' } },
      { id: 'n1', type: 'agent', data: { agentId: 'e', input: 'count={{var.count}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
      { id: 'e2', source: 'v2', target: 'v3' },
      { id: 'e3', source: 'v3', target: 'n1' },
    ],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.steps.find((s) => s.nodeId === 'v2')?.output, 11)
  assert.equal(result.steps.find((s) => s.nodeId === 'v3')?.output, 16)
  assert.equal(result.output, 'count=16')
})

test('variable decrement subtracts the amount', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'count', varType: 'integer', value: '10' } },
      { id: 'v2', type: 'variable', data: { op: 'decrement', name: 'count', value: '3' } },
      { id: 'v3', type: 'variable', data: { op: 'decrement', name: 'count' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
      { id: 'e2', source: 'v2', target: 'v3' },
    ],
  }
  const result = await interpretFlow(graph, '', { runAgent: async () => ({ output: '' }) })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.steps.find((s) => s.nodeId === 'v2')?.output, 7)
  assert.equal(result.steps.find((s) => s.nodeId === 'v3')?.output, 6)
})

test('variable appendArray pushes onto an initialized array', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'tags', varType: 'array', value: '["a"]' } },
      { id: 'v2', type: 'variable', data: { op: 'appendArray', name: 'tags', value: 'b' } },
      { id: 'v3', type: 'variable', data: { op: 'appendArray', name: 'tags', value: '{{trigger.input}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
      { id: 'e2', source: 'v2', target: 'v3' },
    ],
  }
  const result = await interpretFlow(graph, { name: 'Acme' }, { runAgent: async () => ({ output: '' }) })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(result.steps.find((s) => s.nodeId === 'v3')?.output, ['a', 'b', { name: 'Acme' }])
})

test('variable appendString concatenates onto an initialized string', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'log', value: 'start' } },
      { id: 'v2', type: 'variable', data: { op: 'appendString', name: 'log', value: ' then {{trigger.input}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
    ],
  }
  const result = await interpretFlow(graph, 'Acme', { runAgent: async () => ({ output: '' }) })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.steps.find((s) => s.nodeId === 'v2')?.output, 'start then Acme')
})

test('variable set resolves a templated value referencing a prior step', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'score', varType: 'integer', value: '0' } },
      { id: 'n1', type: 'agent', data: { agentId: 'score', input: 'x' } },
      { id: 'v2', type: 'variable', data: { op: 'set', name: 'score', value: '{{step.n1.output.score}}' } },
      { id: 'n2', type: 'agent', data: { agentId: 'e', input: 'score={{var.score}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'n1' },
      { id: 'e2', source: 'n1', target: 'v2' },
      { id: 'e3', source: 'v2', target: 'n2' },
    ],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.agentId === 'score' ? '{"score":91}' : n.input })
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.steps.find((s) => s.nodeId === 'v2')?.output, 91) // stays numeric
  assert.equal(result.output, 'score=91')
})

test('variable initialize integer with a non-numeric value fails with a plain message', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'count', varType: 'integer', value: 'abc' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'v1' }],
  }
  const result = await interpretFlow(graph, '', { runAgent: async () => ({ output: '' }) })
  assert.equal(result.status, 'failed')
  const step = result.steps.find((s) => s.nodeId === 'v1')
  assert.equal(step?.status, 'failed')
  assert.match(step?.error ?? '', /whole number/)
  assert.match(step?.error ?? '', /"abc"/)
})

test('variable increment on a string variable fails', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'greeting', varType: 'string', value: 'hi' } },
      { id: 'v2', type: 'variable', data: { op: 'increment', name: 'greeting' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
    ],
  }
  const result = await interpretFlow(graph, '', { runAgent: async () => ({ output: '' }) })
  assert.equal(result.status, 'failed')
  assert.match(result.steps.find((s) => s.nodeId === 'v2')?.error ?? '', /isn't a number/)
})

test('variable ops on a never-initialized name fail cleanly', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'set', name: 'ghost', value: 'x' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'v1' }],
  }
  const result = await interpretFlow(graph, '', { runAgent: async () => ({ output: '' }) })
  assert.equal(result.status, 'failed')
  assert.match(result.steps.find((s) => s.nodeId === 'v1')?.error ?? '', /hasn't been initialized/)
})

test('{{var.x}} resolves inside an agent step input, including object fields', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'deal', varType: 'object', value: '{"name":"Acme","stage":"closed"}' } },
      { id: 'n1', type: 'agent', data: { agentId: 'e', input: 'deal {{var.deal.name}} is {{var.deal.stage}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'n1' },
    ],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.output, 'deal Acme is closed')
})

test('variables mutated inside a loop body persist after the loop', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'count', varType: 'integer', value: '0' } },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['inc'] } },
      { id: 'inc', type: 'variable', data: { op: 'increment', name: 'count' } },
      { id: 'n1', type: 'agent', data: { agentId: 'e', input: 'count={{var.count}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'loop' },
      { id: 'e2', source: 'loop', target: 'n1' },
    ],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  const result = await interpretFlow(graph, ['a', 'b', 'c'], { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'count=3')
})

test('resume replays completed variable steps back into the symbol table', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'count', varType: 'integer', value: '1' } },
      { id: 'v2', type: 'variable', data: { op: 'increment', name: 'count' } },
      { id: 'ask', type: 'agent', data: { agentId: 'ask', input: 'x' } },
      { id: 'n2', type: 'agent', data: { agentId: 'e', input: 'count={{var.count}} reply={{step.ask.output}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
      { id: 'e2', source: 'v2', target: 'ask' },
      { id: 'e3', source: 'ask', target: 'n2' },
    ],
  }
  const ran: string[] = []
  const runAgent: RunAgentFn = async (n) => {
    ran.push(n.id)
    if (n.id === 'ask') return { output: n.resume ? 'ANSWERED' : 'ignored' }
    return { output: n.input }
  }
  // Resume: v1/v2 replay from stored outputs (they are NOT re-executed), so the
  // variables map must be reconstructed from those outputs for n2 to read.
  const result = await interpretFlow(graph, '', {
    runAgent,
    completed: { v1: 1, v2: 2 },
    resumeNodeId: 'ask',
  })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(ran, ['ask', 'n2'])
  assert.equal(result.output, 'count=2 reply=ANSWERED')
})

test('resume restores variable writes made inside a completed loop body', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'count', varType: 'integer', value: '0' } },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['inc'] } },
      { id: 'inc', type: 'variable', data: { op: 'increment', name: 'count' } },
      { id: 'ask', type: 'agent', data: { agentId: 'ask', input: 'x' } },
      { id: 'n2', type: 'agent', data: { agentId: 'e', input: 'count={{var.count}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'loop' },
      { id: 'e2', source: 'loop', target: 'ask' },
      { id: 'e3', source: 'ask', target: 'n2' },
    ],
  }
  const ran: string[] = []
  const runAgent: RunAgentFn = async (n) => {
    ran.push(n.id)
    if (n.id === 'ask') return { output: 'ANSWERED' }
    return { output: n.input }
  }
  // Prior run: v1 wrote 0, the loop body incremented count to 3 (a stored
  // output is the LAST post-op value for that node), the loop completed, then
  // `ask` paused. The resumed walk short-circuits the completed loop without
  // entering its body — `inc` lives in `contained` — so its write must be
  // replayed from the completed map up front, not during the walk.
  const result = await interpretFlow(graph, ['a', 'b', 'c'], {
    runAgent,
    completed: { v1: 0, inc: 3, loop: [1, 2, 3] },
    resumeNodeId: 'ask',
  })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(ran, ['ask', 'n2'])
  assert.equal(result.output, 'count=3')
})

test('resume restores variable writes made inside completed parallel branches', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'total', varType: 'integer', value: '0' } },
      { id: 'par', type: 'parallel', data: { branches: [['va'], ['vb']] } },
      { id: 'va', type: 'variable', data: { op: 'increment', name: 'total', value: '1' } },
      { id: 'vb', type: 'variable', data: { op: 'increment', name: 'total', value: '2' } },
      { id: 'ask', type: 'agent', data: { agentId: 'ask', input: 'x' } },
      { id: 'n2', type: 'agent', data: { agentId: 'e', input: 'total={{var.total}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'par' },
      { id: 'e2', source: 'par', target: 'ask' },
      { id: 'e3', source: 'ask', target: 'n2' },
    ],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.id === 'ask' ? 'ANSWERED' : n.input })
  const result = await interpretFlow(graph, '', {
    runAgent,
    completed: { v1: 0, va: 1, vb: 3, par: { va: 1, vb: 3 } },
    resumeNodeId: 'ask',
  })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'total=3')
})

test('resume replays completed variable steps in execution order — the later set wins', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'greeting', varType: 'string', value: 'first' } },
      { id: 'v2', type: 'variable', data: { op: 'set', name: 'greeting', value: 'second' } },
      { id: 'ask', type: 'agent', data: { agentId: 'ask', input: 'x' } },
      { id: 'n2', type: 'agent', data: { agentId: 'e', input: 'greeting={{var.greeting}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
      { id: 'e2', source: 'v2', target: 'ask' },
      { id: 'e3', source: 'ask', target: 'n2' },
    ],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.id === 'ask' ? 'ANSWERED' : n.input })
  // `completed` preserves execution order (rows load `order asc`), so the
  // initialize replays first and the set's value is what survives.
  const result = await interpretFlow(graph, '', {
    runAgent,
    completed: { v1: 'first', v2: 'second' },
    resumeNodeId: 'ask',
  })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'greeting=second')
})

test('declared float type governs set and increment even when the current value is whole', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'pi', varType: 'float' } },
      { id: 'v2', type: 'variable', data: { op: 'set', name: 'pi', value: '3.5' } },
      { id: 'v3', type: 'variable', data: { op: 'increment', name: 'pi', value: '0.25' } },
      { id: 'n1', type: 'agent', data: { agentId: 'e', input: 'pi={{var.pi}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
      { id: 'e2', source: 'v2', target: 'v3' },
      { id: 'e3', source: 'v3', target: 'n1' },
    ],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  // The blank initialize defaults pi to 0 — a whole number — but the DECLARED
  // float type must keep governing later coercions.
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'pi=3.75')
})

test('set on a declared integer variable still rejects a non-whole value', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'count', varType: 'integer', value: '0' } },
      { id: 'v2', type: 'variable', data: { op: 'set', name: 'count', value: '3.7' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
    ],
  }
  const result = await interpretFlow(graph, '', { runAgent: stub({}) })
  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /whole number/)
})

test('increment amount that resolves empty fails instead of silently adding 0', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'count', varType: 'integer', value: '5' } },
      { id: 'v2', type: 'variable', data: { op: 'increment', name: 'count', value: '{{step.missing.output}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
    ],
  }
  const result = await interpretFlow(graph, '', { runAgent: stub({}) })
  assert.equal(result.status, 'failed')
  assert.equal(result.error, 'Variable "count" needs a number for the amount — the value came back empty.')
})

test('set value that resolves empty fails instead of resetting to the type default', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'label', varType: 'string', value: 'x' } },
      { id: 'v2', type: 'variable', data: { op: 'set', name: 'label', value: '{{step.missing.output}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
    ],
  }
  const result = await interpretFlow(graph, '', { runAgent: stub({}) })
  assert.equal(result.status, 'failed')
  assert.equal(result.error, 'Variable "label" needs a value — the value came back empty.')
})

test('set with a literally empty value field still clears a string variable', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'greeting', varType: 'string', value: 'hello' } },
      { id: 'v2', type: 'variable', data: { op: 'set', name: 'greeting', value: '' } },
      { id: 'n1', type: 'agent', data: { agentId: 'e', input: 'greeting=[{{var.greeting}}]' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
      { id: 'e2', source: 'v2', target: 'n1' },
    ],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  // The user configured an empty value on purpose — an empty string is a
  // legitimate set, unlike a token that resolved to nothing.
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'greeting=[]')
})

// ── data operation steps ─────────────────────────────────────────────────────

test('data step joins a prior step output and feeds a later step', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'list', input: 'x' } },
      { id: 'd1', type: 'data', data: { op: 'join', input: '{{step.n1.output}}', separator: ' - ' } },
      { id: 'n2', type: 'agent', data: { agentId: 'echo', input: 'got {{step.d1.output}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'd1' },
      { id: 'e2', source: 'd1', target: 'n2' },
    ],
  }
  const result = await interpretFlow(graph, '', { runAgent: stub({ list: '["a","b","c"]' }) })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'ran:got a - b - c')
})

test('data parseJson exposes fields to downstream steps', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'd1', type: 'data', data: { op: 'parseJson', input: '{{trigger.input}}' } },
      { id: 'n1', type: 'agent', data: { agentId: 'echo', input: 'score={{step.d1.output.score}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'd1' },
      { id: 'e1', source: 'd1', target: 'n1' },
    ],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  const result = await interpretFlow(graph, '{"score": 91}', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'score=91')
})

test('data parseJson on invalid content fails the run with a plain message', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'd1', type: 'data', data: { op: 'parseJson', input: '{{trigger.input}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'd1' }],
  }
  const result = await interpretFlow(graph, 'not json at all', { runAgent: stub({}) })
  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /Parse JSON needs valid JSON/)
})

test('data filterArray filters a prior step output by item fields', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'list', input: 'x' } },
      { id: 'd1', type: 'data', data: { op: 'filterArray', input: '{{step.n1.output}}', clauses: [{ left: '{{item.stage}}', op: 'eq', right: 'open' }] } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'd1' },
    ],
  }
  const result = await interpretFlow(graph, '', {
    runAgent: stub({ list: '[{"stage":"open","name":"A"},{"stage":"closed","name":"B"}]' }),
  })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(result.output, [{ stage: 'open', name: 'A' }])
})

test('data select maps items and feeds an html table downstream', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'd1', type: 'data', data: { op: 'select', input: '{{trigger.input}}', fields: [{ name: 'company', value: '{{item.name}}' }] } },
      { id: 'd2', type: 'data', data: { op: 'htmlTable', input: '{{step.d1.output}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'd1' },
      { id: 'e1', source: 'd1', target: 'd2' },
    ],
  }
  const result = await interpretFlow(graph, [{ name: '<b>Acme</b>' }], { runAgent: stub({}) })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, '<table><thead><tr><th>company</th></tr></thead><tbody><tr><td>&lt;b&gt;Acme&lt;/b&gt;</td></tr></tbody></table>')
})

test('data compose passes trigger input structure through to later steps', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'd1', type: 'data', data: { op: 'compose', input: '{{trigger.input.account}}' } },
      { id: 'n1', type: 'agent', data: { agentId: 'echo', input: 'name={{step.d1.output.name}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'd1' },
      { id: 'e1', source: 'd1', target: 'n1' },
    ],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  const result = await interpretFlow(graph, { account: { name: 'Acme' } }, { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'name=Acme')
})

test('humanReview pauses the flow with a resolved templated message', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: '{{trigger.input}}' } },
      { id: 'hr', type: 'humanReview', data: { message: 'Confirm the plan for {{step.n1.output}}' } },
      { id: 'n2', type: 'agent', data: { agentId: 'a2', input: 'never runs' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'hr' },
      { id: 'e2', source: 'hr', target: 'n2' },
    ],
  }
  const result = await interpretFlow(graph, 'x', { runAgent: stub({ a1: 'Acme' }) })
  assert.equal(result.status, 'waiting')
  assert.equal(result.waiting?.nodeId, 'hr')
  assert.equal(result.waiting?.question, 'Confirm the plan for Acme')
  const hr = result.steps.find((step) => step.nodeId === 'hr')
  assert.equal(hr?.status, 'waiting')
  // The pause reason rides on the outcome so execute-flow's onStep persistence
  // stores the same waiting shape the agent adapter writes (kind 'input').
  assert.deepEqual(hr?.output, { waiting: { kind: 'input', question: 'Confirm the plan for Acme' } })
  assert.ok(!result.steps.some((step) => step.nodeId === 'n2'))
})

test('humanReview resume turns the reply into the step output for downstream steps', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: '{{trigger.input}}' } },
      { id: 'hr', type: 'humanReview', data: { message: 'Confirm the plan for {{step.n1.output}}' } },
      { id: 'n2', type: 'agent', data: { agentId: 'a2', input: 'got {{step.hr.output}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'hr' },
      { id: 'e2', source: 'hr', target: 'n2' },
    ],
  }
  const result = await interpretFlow(graph, 'x', {
    runAgent: stub({}),
    completed: { n1: 'Acme' },
    resumeNodeId: 'hr',
    resumeReply: 'Approved by Jane',
  })
  assert.equal(result.status, 'succeeded')
  const hr = result.steps.find((step) => step.nodeId === 'hr')
  assert.equal(hr?.status, 'succeeded')
  assert.equal(hr?.output, 'Approved by Jane')
  assert.equal(result.output, 'ran:got Approved by Jane')
})

// ── Loop resume-from-cursor: a mid-loop pause must not re-run prior iterations ──

test('a loop that paused on item 1 resumes without re-running item 0', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['a'] } },
      { id: 'a', type: 'agent', data: { agentId: 'work', input: '{{item}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  // The stub keys off the per-iteration node id (`a#<index>`): item 1 pauses on
  // its first visit and re-enters with the reply on resume; every other item
  // echoes `out-<index>`.
  let calls: number[] = []
  const runAgent: RunAgentFn = async (node) => {
    const index = Number(node.id.split('#')[1] ?? -1)
    calls.push(index)
    if (index === 1) {
      return node.resume ? { output: 'reply-1' } : { waiting: { status: 'waiting_for_input', question: 'Which?' } }
    }
    return { output: `out-${index}` }
  }

  // First run pauses at item 1. The pause control must carry the iteration
  // index so resume can target the exact paused iteration.
  const first = await interpretFlow(graph, ['x', 'y', 'z'], { runAgent })
  assert.equal(first.status, 'waiting')
  assert.equal(first.waiting?.nodeId, 'a#1')

  // Resume: item 0's body output is already recorded under its per-iteration
  // key; the reply targets item 1's node.
  calls = []
  const resumed = await interpretFlow(graph, ['x', 'y', 'z'], {
    runAgent,
    completed: { 'a#0': 'out-0' },
    resumeNodeId: 'a#1',
    resumeReply: 'reply-1',
  })
  assert.equal(resumed.status, 'succeeded')
  assert.ok(!calls.includes(0), 'item 0 must NOT be re-invoked on resume')
  assert.deepEqual(calls, [1, 2]) // item 1 (resumed with reply), then item 2 (fresh)
  assert.deepEqual(resumed.output, ['out-0', 'reply-1', 'out-2']) // all three, in order
})

test('a partially-completed iteration skips its finished body steps and resumes at the paused one', async () => {
  // A two-node body: `b1` runs, then `b2` (the pauser). On resume, item 1's
  // ALREADY-completed `b1#1` must not re-run — only `b2#1` resumes.
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['b1', 'b2'] } },
      { id: 'b1', type: 'agent', data: { agentId: 'first', input: 'b1 {{item}}' } },
      { id: 'b2', type: 'agent', data: { agentId: 'second', input: 'b2 {{item}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const ran: string[] = []
  const runAgent: RunAgentFn = async (node) => {
    ran.push(node.id)
    if (node.id === 'b2#1') return node.resume ? { output: 'answered-1' } : { waiting: { status: 'waiting_for_input' } }
    return { output: node.input }
  }
  const resumed = await interpretFlow(graph, ['x', 'y'], {
    runAgent,
    completed: { 'b1#0': 'b1 x', 'b2#0': 'b2 x', 'b1#1': 'b1 y' },
    resumeNodeId: 'b2#1',
    resumeReply: 'answered-1',
  })
  assert.equal(resumed.status, 'succeeded')
  // Neither iteration 0's body nor iteration 1's ALREADY-done b1 re-runs — only
  // the paused b2#1 does.
  assert.deepEqual(ran, ['b2#1'])
  assert.deepEqual(resumed.output, ['b2 x', 'answered-1'])
})

// ── Context tokens: {{now}} + run/flow metadata ─────────────────────────────

const NOW = { iso: '2026-07-12T09:30:00.000Z', date: '2026-07-12', time: '09:30:00', unix: 1_752_312_600 }
const RUN = {
  id: 'run_42',
  url: '/flows/flow_7?run=run_42',
  trigger: 'schedule',
  startedAt: '2026-07-12T09:29:00.000Z',
  flowId: 'flow_7',
  flowName: 'Weekly digest',
}

test('{{now}} resolves to the injected run clock', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: 'at {{now}} ({{now.date}} {{now.time}} #{{now.unix}})' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  const runAgent: RunAgentFn = async (node) => ({ output: node.input })
  const result = await interpretFlow(graph, '', { runAgent, now: NOW })
  assert.equal(result.output, 'at 2026-07-12T09:30:00.000Z (2026-07-12 09:30:00 #1752312600)')
})

test('{{flow.name}} and {{run.id}} resolve from run metadata', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: '{{flow.name}} [{{flow.id}}] / {{run.id}} / {{run.trigger}} / {{run.url}} / {{run.startedAt}}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  const runAgent: RunAgentFn = async (node) => ({ output: node.input })
  const result = await interpretFlow(graph, '', { runAgent, run: RUN })
  assert.equal(result.output, 'Weekly digest [flow_7] / run_42 / schedule / /flows/flow_7?run=run_42 / 2026-07-12T09:29:00.000Z')
})

test('unknown run/flow/now subpaths resolve to empty (never crash)', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: 'a{{run.bogus}}b{{flow.bogus}}c{{now.bogus}}d' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  const runAgent: RunAgentFn = async (node) => ({ output: node.input })
  const result = await interpretFlow(graph, '', { runAgent, now: NOW, run: RUN })
  assert.equal(result.output, 'abcd')
})

test('context tokens resolve to empty when no metadata is injected', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: 'x{{now}}y{{run.id}}z{{flow.name}}w' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  const runAgent: RunAgentFn = async (node) => ({ output: node.input })
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.output, 'xyzw')
})

test('{{now}} is stable across two steps in one run (same injected clock)', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: '{{now}}' } },
      { id: 'n2', type: 'agent', data: { agentId: 'a2', input: '{{now}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'n2' },
    ],
  }
  const seen: string[] = []
  const runAgent: RunAgentFn = async (node) => {
    seen.push(node.input)
    return { output: node.input }
  }
  await interpretFlow(graph, '', { runAgent, now: NOW })
  assert.equal(seen.length, 2)
  assert.equal(seen[0], seen[1])
  assert.equal(seen[0], NOW.iso)
})

test('{{now}} and {{run.id}} are available inside a loop body', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['echo'] } },
      { id: 'echo', type: 'agent', data: { agentId: 'echo', input: '{{item}}@{{now}}#{{run.id}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const runAgent: RunAgentFn = async (node) => ({ output: node.input })
  const result = await interpretFlow(graph, ['A', 'B'], { runAgent, now: NOW, run: RUN })
  assert.deepEqual(result.output, [`A@${NOW.iso}#run_42`, `B@${NOW.iso}#run_42`])
})

// ── Output node: named flow outputs ──────────────────────────────────────────

test('output node records named values from templated values, preserving structure', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'score', input: 'x' } },
      {
        id: 'out',
        type: 'output',
        data: {
          outputs: [
            { name: 'greeting', value: 'Hi {{trigger.input}}', type: 'text' },
            { name: 'score', value: '{{step.n1.output.score}}', type: 'any' },
          ],
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'out' },
    ],
  }
  const result = await interpretFlow(graph, 'Acme', { runAgent: stub({ score: '{"score":91}' }) })
  assert.equal(result.status, 'succeeded')
  // Both names present; the exact-token value keeps its number type, the mixed
  // template resolves to a string.
  assert.deepEqual(result.namedOutputs, { greeting: 'Hi Acme', score: 91 })
})

test('a step after an output node still runs (output is a passthrough, not a terminator)', async () => {
  const seen: string[] = []
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'out', type: 'output', data: { outputs: [{ name: 'greeting', value: 'hello', type: 'text' }] } },
      { id: 'after', type: 'agent', data: { agentId: 'after', input: 'ran-after' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'out' },
      { id: 'e1', source: 'out', target: 'after' },
    ],
  }
  const runAgent: RunAgentFn = async (n) => {
    seen.push(n.agentId)
    return { output: n.input }
  }
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(seen, ['after']) // the downstream step ran after the output node
  assert.deepEqual(result.namedOutputs, { greeting: 'hello' })
})

test('later output nodes merge and override earlier named outputs', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'o1', type: 'output', data: { outputs: [{ name: 'a', value: '1' }, { name: 'b', value: '2' }] } },
      { id: 'o2', type: 'output', data: { outputs: [{ name: 'b', value: '99' }, { name: 'c', value: '3' }] } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'o1' },
      { id: 'e1', source: 'o1', target: 'o2' },
    ],
  }
  const result = await interpretFlow(graph, '', { runAgent: stub({}) })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(result.namedOutputs, { a: '1', b: '99', c: '3' })
})

test('no output node leaves namedOutputs undefined and keeps the last-step output (regression)', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: '{{trigger.input}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'n1' }],
  }
  const result = await interpretFlow(graph, 'hello', { runAgent: stub({ a1: 'DONE' }) })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'DONE') // last-step output is untouched
  assert.equal(result.namedOutputs, undefined) // no named outputs when no output node ran
})

test('resume reconstructs named outputs from a completed output node before a pause', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'o', type: 'output', data: { outputs: [{ name: 'summary', value: '{{trigger.input}}', type: 'text' }] } },
      { id: 'h', type: 'humanReview', data: { message: 'Approve?' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'o' },
      { id: 'e1', source: 'o', target: 'h' },
    ],
  }
  const runAgent: RunAgentFn = async () => ({ output: 'unused' })
  // Prior run: the output node ran (its resolved named map was stored on the
  // step row and reloaded into `completed`) and the humanReview paused. On
  // resume the output node hits the completed short-circuit and never re-enters
  // its branch, so the run-level namedOutputs collector must be rebuilt from the
  // completed map — otherwise the reviewer's reply (the last-step output) would
  // clobber the declared named outputs on final completion.
  const result = await interpretFlow(graph, 'Acme', {
    runAgent,
    completed: { o: { summary: 'Acme' } },
    resumeNodeId: 'h',
    resumeReply: 'looks good',
  })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(result.namedOutputs, { summary: 'Acme' }) // survives the resume
  assert.equal(result.output, 'looks good') // the reply is the last-step output — but namedOutputs wins downstream
})

test('an output node with an empty outputs array does not clobber the last-step output at runtime', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: 'x' } },
      { id: 'out', type: 'output', data: { outputs: [] } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'out' },
    ],
  }
  // validate.ts blocks an empty outputs array; this is the belt-and-suspenders
  // runtime guard for the degenerate case. An empty named-output map must not
  // register as named outputs, nor overwrite the real last-step output with {}.
  const result = await interpretFlow(graph, '', { runAgent: stub({ a1: 'REAL' }) })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'REAL') // agent's real result, not {}
  assert.equal(result.namedOutputs, undefined) // an empty map is not "named outputs"
})

test('subflow step resolves inputs map + fallback input, passes flowId through, threads structured child output', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      {
        id: 's1',
        type: 'subflow',
        data: { flowId: 'child-1', inputs: { account: '{{trigger.input}}', note: 'literal' }, input: 'ignored fallback', retries: 1, timeoutMs: 8000 },
      },
      { id: 'd1', type: 'data', data: { op: 'compose', input: '{{step.s1.output.summary}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 's1' },
      { id: 'e1', source: 's1', target: 'd1' },
    ],
  }
  const calls: Record<string, unknown>[] = []
  const runAction: RunActionFn = async (node) => {
    calls.push({ kind: node.kind, ...node.config })
    return { output: { summary: 'child says hi', count: 2 } }
  }
  const result = await interpretFlow(graph, 'Acme', { runAgent: async () => ({ output: 'unused' }), runAction })
  assert.equal(result.status, 'succeeded')
  assert.equal(calls[0].kind, 'subflow')
  assert.equal(calls[0].flowId, 'child-1')
  assert.deepEqual(calls[0].inputs, { account: 'Acme', note: 'literal' })
  assert.equal(calls[0].retries, 1)
  assert.equal(calls[0].timeoutMs, 8000)
  assert.equal(result.output, 'child says hi')
})

test('subflow adapter error honors onError route down the error edge', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 's1', type: 'subflow', data: { flowId: 'child-1', onError: 'route' } },
      { id: 'ok1', type: 'data', data: { op: 'compose', input: 'normal path' } },
      { id: 'err1', type: 'data', data: { op: 'compose', input: 'Error was: {{step.s1.output.error}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 's1' },
      { id: 'e1', source: 's1', target: 'ok1' },
      { id: 'e2', source: 's1', target: 'err1', branch: 'error' },
    ],
  }
  const runAction: RunActionFn = async () => ({ error: 'child failed hard' })
  const result = await interpretFlow(graph, '', { runAgent: async () => ({ output: 'unused' }), runAction })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'Error was: child failed hard')
})

test('knowledge step resolves the query and threads the hit list', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'k1', type: 'knowledge', data: { query: 'About {{trigger.input}}', topK: 3 } },
      { id: 'd1', type: 'data', data: { op: 'getItem', input: '{{step.k1.output}}', index: '0' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'k1' },
      { id: 'e1', source: 'k1', target: 'd1' },
    ],
  }
  const calls: Record<string, unknown>[] = []
  const runAction: RunActionFn = async (node) => {
    calls.push({ kind: node.kind, ...node.config })
    return { output: [{ content: 'passage', filename: 'deck.pdf', score: 0.9 }] }
  }
  const result = await interpretFlow(graph, 'Acme', { runAgent: async () => ({ output: 'unused' }), runAction })
  assert.equal(result.status, 'succeeded')
  assert.equal(calls[0].kind, 'knowledge')
  assert.equal(calls[0].query, 'About Acme')
  assert.equal(calls[0].topK, 3)
  assert.deepEqual(result.output, { content: 'passage', filename: 'deck.pdf', score: 0.9 })
})

test('resume replay re-takes the error edge for a route-failed step (completedRoutes)', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 't1', type: 'ai', data: { aiOp: 'ask', input: 'x', onError: 'route' } },
      { id: 'ok1', type: 'data', data: { op: 'compose', input: 'normal path' } },
      { id: 'err1', type: 'data', data: { op: 'compose', input: 'handled: {{step.t1.output.error}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 't1' },
      { id: 'e1', source: 't1', target: 'ok1' },
      { id: 'e2', source: 't1', target: 'err1', branch: 'error' },
    ],
  }
  let adapterCalls = 0
  const runAction: RunActionFn = async () => {
    adapterCalls++
    return { output: 'would succeed now' }
  }
  const result = await interpretFlow(graph, '', {
    runAgent: async () => ({ output: 'unused' }),
    runAction,
    completed: { t1: { error: 'boom', input: { aiOp: 'ask' } } },
    completedRoutes: new Set(['t1']),
    resumeNodeId: 'err1',
  })
  assert.equal(adapterCalls, 0, 'route-failed step must not re-execute')
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'handled: boom', 'walk re-took the error edge')
})

test('a tool arg can reference the previous step by its display LABEL (the Slack bug)', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: '{{trigger.input}}', label: 'Previous Agent' } },
      { id: 't1', type: 'tool', data: { connectionId: 'c1', toolName: 'post_message', args: '{"channel":"#sales","text":"{{Previous Agent.output.message}}"}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 't1' },
    ],
  }
  const calls: Record<string, unknown>[] = []
  const runAction: RunActionFn = async (node) => {
    calls.push(node.config)
    return { output: 'ok' }
  }
  const result = await interpretFlow(graph, 'lead', { runAgent: stub({ a1: 'Qualified: strong fit.' }), runAction })
  assert.equal(result.status, 'succeeded')
  // The label path resolved to the agent's plain-text output — never "".
  assert.deepEqual(calls[0].args, { channel: '#sales', text: 'Qualified: strong fit.' })
})

test('a tool arg with a truly unknown reference fails the step with the token named', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 't1', type: 'tool', data: { connectionId: 'c1', toolName: 'post_message', args: '{"text":"{{Nonexistent Step.output}}"}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 't1' }],
  }
  let dispatched = 0
  const runAction: RunActionFn = async () => {
    dispatched++
    return { output: 'ok' }
  }
  const result = await interpretFlow(graph, '', { runAgent: async () => ({ output: 'unused' }), runAction })
  assert.equal(result.status, 'failed')
  assert.equal(dispatched, 0, 'the tool must not run with silently-blanked args')
  assert.ok(result.error?.includes('{{Nonexistent Step.output}}'), `error names the exact token: ${result.error}`)
})

test('a canonical token naming a real step that produced no output stays empty, not a failure', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'flaky', type: 'agent', data: { agentId: 'a1', input: 'x', onError: 'continue' } },
      { id: 't1', type: 'tool', data: { connectionId: 'c1', toolName: 'send', args: '{"text":"got:{{step.flaky.output}}"}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'flaky' },
      { id: 'e1', source: 'flaky', target: 't1' },
    ],
  }
  const calls: Record<string, unknown>[] = []
  const runAction: RunActionFn = async (node) => {
    calls.push(node.config)
    return { output: 'ok' }
  }
  const runAgent: RunAgentFn = async () => ({ error: 'boom' })
  const result = await interpretFlow(graph, '', { runAgent, runAction })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(calls[0].args, { text: 'got:' }, 'continue-failed step reads as empty, not unknown')
})

test('SCENARIO: API nodes run before an agent, and the agent auto-receives all their data', async () => {
  // trigger → http(fetch CRM) → http(fetch usage) → agent. The agent input is
  // BARE ({{trigger.input}}), yet it must still receive both API payloads —
  // this is the "nodes work together" parity the aggregation delivers.
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'crm', type: 'http', data: { method: 'GET', url: 'https://api.example.com/accounts', label: 'Fetch CRM accounts' } },
      { id: 'usage', type: 'http', data: { method: 'GET', url: 'https://api.example.com/usage', label: 'Fetch usage data' } },
      { id: 'agent', type: 'agent', data: { agentId: 'analyst', input: '{{trigger.input}}', label: 'Analyst', includeUpstreamContext: true } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'crm' },
      { id: 'e1', source: 'crm', target: 'usage' },
      { id: 'e2', source: 'usage', target: 'agent' },
    ],
  }
  let promptSeenByAgent = ''
  const runAgent: RunAgentFn = async (node) => {
    promptSeenByAgent = node.input
    return { output: 'analysis done' }
  }
  const runAction: RunActionFn = async (node) => {
    if (node.id === 'crm') return { output: { ok: true, status: 200, statusText: 'OK', url: 'u', headers: {}, body: { accounts: [{ name: 'Acme', arr: 84000 }] }, bodyText: '' } }
    return { output: { ok: true, status: 200, statusText: 'OK', url: 'u', headers: {}, body: { seats: 40, weeklyActive: 31 } }, bodyText: '' }
  }
  const result = await interpretFlow(graph, 'Assess Acme for expansion', { runAgent, runAction })
  assert.equal(result.status, 'succeeded')
  // The agent's prompt carries BOTH API payloads, labeled — unwrapped from the HTTP envelope.
  assert.ok(promptSeenByAgent.includes('Assess Acme for expansion'), 'keeps the original instruction')
  assert.ok(promptSeenByAgent.includes('Data gathered by earlier steps'), 'appends the aggregated context')
  assert.ok(promptSeenByAgent.includes('Fetch CRM accounts') && promptSeenByAgent.includes('Acme'), 'includes CRM data')
  assert.ok(promptSeenByAgent.includes('Fetch usage data') && promptSeenByAgent.includes('weeklyActive'), 'includes usage data')
  // It must be the parsed body, never the raw HTTP envelope metadata.
  assert.ok(!promptSeenByAgent.includes('bodyText'), 'transport envelope is unwrapped away')
})

test('an agent WITHOUT includeUpstreamContext (existing flows) is untouched — no context appended', async () => {
  // Backward-compat guarantee: the field is opt-in, so a run built before this
  // feature behaves exactly as before — the agent sees only its resolved input.
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'crm', type: 'http', data: { method: 'GET', url: 'https://api.example.com/accounts', label: 'Fetch CRM' } },
      { id: 'agent', type: 'agent', data: { agentId: 'a', input: 'Summarize {{step.crm.output.body}}', label: 'Agent' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'crm' },
      { id: 'e1', source: 'crm', target: 'agent' },
    ],
  }
  let seen = ''
  const runAgent: RunAgentFn = async (node) => { seen = node.input; return { output: 'ok' } }
  const runAction: RunActionFn = async () => ({ output: { ok: true, status: 200, statusText: 'OK', url: 'u', headers: {}, body: { x: 1 }, bodyText: '' } })
  const result = await interpretFlow(graph, '', { runAgent, runAction })
  assert.equal(result.status, 'succeeded')
  assert.ok(!seen.includes('Data gathered by earlier steps'), 'undefined → off (no behavior change for existing flows)')
  assert.ok(seen.includes('"x":1') || seen.includes('{"x":1}'), 'the referenced token still resolved')
})

test('includeUpstreamContext:true forces the context even alongside a token; false disables it', async () => {
  const base = (include: boolean | undefined): FlowGraph => ({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'crm', type: 'http', data: { method: 'GET', url: 'https://api.example.com/a', label: 'CRM' } },
      { id: 'agent', type: 'agent', data: { agentId: 'a', input: 'Look at {{step.crm.output.body}}', label: 'Agent', includeUpstreamContext: include } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'crm' },
      { id: 'e1', source: 'crm', target: 'agent' },
    ],
  })
  const runAction: RunActionFn = async () => ({ output: { ok: true, status: 200, statusText: 'OK', url: 'u', headers: {}, body: { y: 2 }, bodyText: '' } })
  const capture = async (include: boolean | undefined) => {
    let seen = ''
    await interpretFlow(base(include), '', { runAgent: async (n) => { seen = n.input; return { output: 'ok' } }, runAction })
    return seen
  }
  assert.ok((await capture(true)).includes('Data gathered by earlier steps'), 'true → always include')
  assert.ok(!(await capture(false)).includes('Data gathered by earlier steps'), 'false → never include')
})

test('condition/switch selection is unchanged after moving into execNode', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'score', input: '{{trigger.input}}' } },
      { id: 'c', type: 'condition', data: { left: '{{step.n1.output.score}}', op: 'gt', right: '80' } },
      { id: 'hi', type: 'agent', data: { agentId: 'high', input: 'x' } },
      { id: 'lo', type: 'agent', data: { agentId: 'low', input: 'x' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'c' },
      { id: 'e2', source: 'c', target: 'hi', branch: 'true' },
      { id: 'e3', source: 'c', target: 'lo', branch: 'false' },
    ],
  }
  const result = await interpretFlow(graph, 'Acme', { runAgent: stub({ score: '{"score":91}', high: 'HIGH', low: 'LOW' }) })
  assert.equal(result.output, 'HIGH')
})

test('DAG fan-in: three independent nodes converge on one agent, which runs once with all their data', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'a', input: 'x', label: 'A' } },
      { id: 'b', type: 'agent', data: { agentId: 'b', input: 'x', label: 'B' } },
      { id: 'c', type: 'agent', data: { agentId: 'c', input: 'x', label: 'C' } },
      { id: 'j', type: 'agent', data: { agentId: 'sink', input: '{{steps}}', label: 'Sink', includeUpstreamContext: false } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'a' },
      { id: 'e1', source: 'trigger', target: 'b' },
      { id: 'e2', source: 'trigger', target: 'c' },
      { id: 'e3', source: 'a', target: 'j' },
      { id: 'e4', source: 'b', target: 'j' },
      { id: 'e5', source: 'c', target: 'j' },
    ],
  }
  let runs = 0
  let sinkInput = ''
  const runAgent: RunAgentFn = async (node) => {
    if (node.agentId === 'sink') { runs++; sinkInput = node.input; return { output: 'merged' } }
    return { output: `${node.agentId.toUpperCase()}-out` }
  }
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(runs, 1, 'the fan-in node runs exactly once, after all parents')
  assert.ok(sinkInput.includes('A-out') && sinkInput.includes('B-out') && sinkInput.includes('C-out'), 'it sees every parent output via {{steps}}')
})

test('DAG dead-path: a condition gates two paths that both feed a join; only the taken side runs, join runs once', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'c', type: 'condition', data: { left: '{{trigger.input}}', op: 'eq', right: 'go' } },
      { id: 'hi', type: 'agent', data: { agentId: 'hi', input: 'x', label: 'Hi' } },
      { id: 'lo', type: 'agent', data: { agentId: 'lo', input: 'x', label: 'Lo' } },
      { id: 'j', type: 'join', data: {} },
      { id: 'end', type: 'agent', data: { agentId: 'end', input: 'x', label: 'End', includeUpstreamContext: false } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'c' },
      { id: 'e1', source: 'c', target: 'hi', branch: 'true' },
      { id: 'e2', source: 'c', target: 'lo', branch: 'false' },
      { id: 'e3', source: 'hi', target: 'j' },
      { id: 'e4', source: 'lo', target: 'j' },
      { id: 'e5', source: 'j', target: 'end' },
    ],
  }
  const seen: string[] = []
  const runAgent: RunAgentFn = async (node) => { seen.push(node.agentId); return { output: `${node.agentId}!` } }
  const result = await interpretFlow(graph, 'go', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.ok(seen.includes('hi') && seen.includes('end'), 'the taken branch and the join both run')
  assert.ok(!seen.includes('lo'), 'the dead branch never runs')
  assert.equal(seen.filter((s) => s === 'end').length, 1, 'the join-downstream node runs exactly once (no per-branch duplication)')
})

test('DAG concurrency: independent parents overlap in time, and the join waits for all', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'a', input: 'x', label: 'A' } },
      { id: 'b', type: 'agent', data: { agentId: 'b', input: 'x', label: 'B' } },
      { id: 'j', type: 'agent', data: { agentId: 'j', input: 'x', label: 'J', includeUpstreamContext: false } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'a' },
      { id: 'e1', source: 'trigger', target: 'b' },
      { id: 'e2', source: 'a', target: 'j' },
      { id: 'e3', source: 'b', target: 'j' },
    ],
  }
  let active = 0, maxActive = 0, jStartedAfter = 0
  const doneParents = { count: 0 }
  const runAgent: RunAgentFn = async (node) => {
    if (node.agentId === 'j') { jStartedAfter = doneParents.count; return { output: 'j' } }
    active++; maxActive = Math.max(maxActive, active)
    await new Promise((r) => setTimeout(r, 20))
    active--; doneParents.count++
    return { output: node.agentId }
  }
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(maxActive, 2, 'a and b run concurrently')
  assert.equal(jStartedAfter, 2, 'j starts only after both parents finished')
})

test('DAG multi-sink: two terminal sinks aggregate by label; a single sink stays bare (back-compat)', async () => {
  const twoSinks: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'x', type: 'agent', data: { agentId: 'x', input: 'x', label: 'X' } },
      { id: 'y', type: 'agent', data: { agentId: 'y', input: 'x', label: 'Y' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'x' },
      { id: 'e1', source: 'trigger', target: 'y' },
    ],
  }
  const runAgent: RunAgentFn = async (node) => ({ output: `${node.agentId}-out` })
  const result = await interpretFlow(twoSinks, '', { runAgent })
  assert.deepEqual(result.output, { X: 'x-out', Y: 'y-out' })
})

test('DAG resume: a diamond with two parents already done resumes and runs only the join', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'a', input: 'x', label: 'A' } },
      { id: 'b', type: 'agent', data: { agentId: 'b', input: 'x', label: 'B' } },
      { id: 'j', type: 'agent', data: { agentId: 'j', input: 'x', label: 'J', includeUpstreamContext: false } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'a' },
      { id: 'e1', source: 'trigger', target: 'b' },
      { id: 'e2', source: 'a', target: 'j' },
      { id: 'e3', source: 'b', target: 'j' },
    ],
  }
  const runs: string[] = []
  const runAgent: RunAgentFn = async (node) => { runs.push(node.agentId); return { output: node.agentId } }
  const result = await interpretFlow(graph, '', { runAgent, completed: { a: 'A-out', b: 'B-out' } })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(runs, ['j'], 'only the unfinished node runs; a and b are not re-executed')
})

test('DAG resume: a filter that dropped on the prior run stays dead (its downstream never runs)', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'p1', type: 'agent', data: { agentId: 'p1', input: 'x', label: 'P1' } },
      { id: 'f', type: 'filter', data: { match: 'all', clauses: [{ left: '{{trigger.input}}', op: 'eq', right: 'never' }] } },
      { id: 'afterFilter', type: 'agent', data: { agentId: 'afterFilter', input: 'x', label: 'AfterFilter' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'p1' },
      { id: 'e1', source: 'p1', target: 'f' },
      { id: 'e2', source: 'f', target: 'afterFilter' },
    ],
  }
  const runs: string[] = []
  const runAgent: RunAgentFn = async (node) => { runs.push(node.agentId); return { output: node.agentId } }
  // Prior run: p1 succeeded, the filter dropped (completed value false).
  const result = await interpretFlow(graph, 'go', { runAgent, completed: { p1: 'P1-out', f: false } })
  assert.equal(result.status, 'succeeded')
  assert.ok(!runs.includes('afterFilter'), 'the node after a dropped filter must not run on resume')
})

test('an unreachable orphan with an out-edge into the chain does not freeze the downstream join', async () => {
  // An import can leave a demoted-trigger stub (no incoming edge) wired into
  // the first real step. The orphan never runs — but its edge must resolve
  // (dead) so the OR-join at n1 still fires off the trigger's edge.
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'orphan', type: 'note', data: { text: 'demoted second trigger' } },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: '{{trigger.input}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'orphan', target: 'n1' },
    ],
  }
  const result = await interpretFlow(graph, 'go', { runAgent: stub({ a1: 'RAN' }) })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'RAN')
  assert.equal(result.steps.filter((s) => s.nodeId === 'n1' && s.status === 'succeeded').length, 1)
})

test('per-item over a single object runs once (n8n parity), not zero times', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      {
        id: 'call',
        type: 'http',
        data: { method: 'GET', url: 'https://api.example.com/{{item.id}}', perItem: { over: '{{trigger.input}}' } },
      },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'call' }],
  }
  const urls: string[] = []
  const runAction: RunActionFn = async (node) => {
    urls.push(String(node.config.url))
    return { output: { ok: true } }
  }
  const single = await interpretFlow(graph, { id: 'one' }, { runAgent: stub({}), runAction })
  assert.equal(single.status, 'succeeded')
  assert.deepEqual(urls, ['https://api.example.com/one'])

  urls.length = 0
  const list = await interpretFlow(graph, [{ id: 'a' }, { id: 'b' }], { runAgent: stub({}), runAction })
  assert.equal(list.status, 'succeeded')
  assert.deepEqual(urls, ['https://api.example.com/a', 'https://api.example.com/b'])

  // A present-but-empty list key stays zero iterations.
  urls.length = 0
  const empty = await interpretFlow(graph, { items: [] }, { runAgent: stub({}), runAction })
  assert.equal(empty.status, 'succeeded')
  assert.deepEqual(urls, [])
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { insertNodeAfter } from '../mutate'
import { emptyGraph } from '../graph'
import { applyCopilotOps, copilotOpSchema, type CopilotOp } from '../copilot-ops'

test('add inserts after target with merged data and validates', () => {
  const g = emptyGraph()
  const result = applyCopilotOps(g, [{ op: 'add', type: 'http', afterId: 'trigger', data: { url: 'https://x.test', method: 'GET' } }] as CopilotOp[])
  assert.equal(result.applied, 1)
  const node = result.graph.nodes.find((n) => n.type === 'http')!
  assert.equal((node.data as { url: string }).url, 'https://x.test')
  assert.deepEqual(result.touchedIds, [node.id])
})

test('add with data that breaks the node schema is skipped, graph unchanged', () => {
  const g = emptyGraph()
  const result = applyCopilotOps(g, [{ op: 'add', type: 'http', afterId: 'trigger', data: { method: 'TELEPORT' } }] as CopilotOp[])
  assert.equal(result.applied, 0)
  assert.equal(result.skipped.length, 1)
  assert.match(result.skipped[0].reason, /schema|invalid/i)
  assert.equal(result.graph, g)
})

test('update merges node data; unknown id skipped; trigger update rejected', () => {
  let g = emptyGraph()
  g = insertNodeAfter(g, 'trigger', 'stop').graph
  const stop = g.nodes.find((n) => n.type === 'stop')!.id
  const ok = applyCopilotOps(g, [{ op: 'update', id: stop, data: { reason: 'done' } }] as CopilotOp[])
  assert.equal(ok.applied, 1)
  const missing = applyCopilotOps(g, [{ op: 'update', id: 'nope', data: {} }] as CopilotOp[])
  assert.equal(missing.skipped[0].reason.includes('not found'), true)
  const trig = applyCopilotOps(g, [{ op: 'update', id: 'trigger', data: {} }] as CopilotOp[])
  assert.equal(trig.applied, 0)
})

test('delete and move route through mutate helpers; sequential ops see prior results', () => {
  let g = emptyGraph()
  g = insertNodeAfter(g, 'trigger', 'http').graph
  const a = g.nodes.find((n) => n.type === 'http')!.id
  const result = applyCopilotOps(g, [
    { op: 'add', type: 'stop', afterId: a },
    { op: 'delete', id: a },
  ] as CopilotOp[])
  assert.equal(result.applied, 2)
  assert.equal(result.graph.nodes.some((n) => n.id === a), false)
  assert.equal(result.graph.nodes.some((n) => n.type === 'stop'), true)
})

test('setTrigger merges trigger data; replace applies only server-sanitized graphs', () => {
  const g = emptyGraph()
  const trig = applyCopilotOps(g, [{ op: 'setTrigger', trigger: { type: 'schedule', schedule: { type: 'daily', time: '09:00' } } }] as CopilotOp[])
  assert.equal(trig.applied, 1)
  const t = trig.graph.nodes.find((n) => n.type === 'trigger')!
  assert.equal(((t.data as { trigger: { type: string } }).trigger).type, 'schedule')
  const unsanitized = applyCopilotOps(g, [{ op: 'replace', graphJson: '{"nodes":[],"edges":[]}' }] as CopilotOp[])
  assert.equal(unsanitized.applied, 0)
  const sane = applyCopilotOps(g, [{ op: 'replace', graphJson: '', graph: insertNodeAfter(emptyGraph(), 'trigger', 'stop').graph } as CopilotOp])
  assert.equal(sane.applied, 1)
  assert.equal(sane.graph.nodes.some((n) => n.type === 'stop'), true)
})

test('wire schema strips a hallucinated graph field from replace ops', () => {
  const parsed = copilotOpSchema.safeParse({ op: 'replace', graphJson: 'x', graph: { nodes: [], edges: [] } })
  assert.equal(parsed.success, true)
  assert.equal(parsed.success && 'graph' in parsed.data, false)
  const result = applyCopilotOps(emptyGraph(), [parsed.success ? (parsed.data as CopilotOp) : ({} as CopilotOp)])
  assert.equal(result.applied, 0)
  assert.equal(result.skipped.length, 1)
  assert.match(result.skipped[0].reason, /unsanitized/)
})

test('update cannot rewrite container reference keys (loop body, parallel branches)', () => {
  let g = emptyGraph()
  g = insertNodeAfter(g, 'trigger', 'loop').graph
  const loop = g.nodes.find((n) => n.type === 'loop')!
  const originalBody = (loop.data as { body: string[] }).body
  const result = applyCopilotOps(g, [{ op: 'update', id: loop.id, data: { body: ['trigger'], label: 'x' } }] as CopilotOp[])
  assert.equal(result.applied, 1)
  const updated = result.graph.nodes.find((n) => n.id === loop.id)!
  assert.equal((updated.data as { label?: string }).label, 'x')
  assert.deepEqual((updated.data as { body: string[] }).body, originalBody)
})

test('container-ref strip is scoped by type: http body stays mergeable', () => {
  let g = emptyGraph()
  g = insertNodeAfter(g, 'trigger', 'http').graph
  const http = g.nodes.find((n) => n.type === 'http')!
  const result = applyCopilotOps(g, [{ op: 'update', id: http.id, data: { body: '{"x":1}' } }] as CopilotOp[])
  assert.equal(result.applied, 1)
  const updated = result.graph.nodes.find((n) => n.id === http.id)!
  assert.equal((updated.data as { body?: string }).body, '{"x":1}')
})

test('copilotOpSchema parses model-shaped ops and tolerates extra keys', () => {
  const parsed = copilotOpSchema.safeParse({ op: 'add', type: 'http', afterId: 'trigger', data: { url: 'https://x.test' }, note: 'why not' })
  assert.equal(parsed.success, true)
  const badOp = copilotOpSchema.safeParse({ op: 'teleport', id: 'n2' })
  assert.equal(badOp.success, false)
  const replace = copilotOpSchema.safeParse({ op: 'replace', graphJson: '{"nodes":[],"edges":[]}' })
  assert.equal(replace.success, true)
})

test('copilotOpSchema strips unknown keys from every op kind, keeping free-form payloads intact', () => {
  const parsed = copilotOpSchema.safeParse({ op: 'delete', id: 'n1', graph: { nodes: [], edges: [] }, note: '<script>alert(1)</script>' })
  assert.equal(parsed.success, true)
  if (!parsed.success) return
  assert.equal('graph' in parsed.data, false)
  assert.equal('note' in parsed.data, false)
  assert.deepEqual(parsed.data, { op: 'delete', id: 'n1' })
  // The nested data/trigger payloads stay free-form: arbitrary keys survive.
  const add = copilotOpSchema.safeParse({ op: 'add', type: 'http', afterId: 'trigger', data: { url: 'https://x.test', custom: 1 }, junk: true })
  assert.equal(add.success, true)
  if (!add.success || add.data.op !== 'add') return
  assert.equal('junk' in add.data, false)
  assert.deepEqual(add.data.data, { url: 'https://x.test', custom: 1 })
  const trig = copilotOpSchema.safeParse({ op: 'setTrigger', trigger: { type: 'manual', extra: 'kept' }, junk: true })
  assert.equal(trig.success, true)
  if (!trig.success || trig.data.op !== 'setTrigger') return
  assert.equal('junk' in trig.data, false)
  assert.deepEqual(trig.data.trigger, { type: 'manual', extra: 'kept' })
})

test('copilot can add an ai step with op config', () => {
  const g = emptyGraph()
  const result = applyCopilotOps(g, [
    { op: 'add', type: 'ai', afterId: 'trigger', data: { aiOp: 'categorize', input: '{{trigger.input}}', categories: ['Urgent', 'Routine'] } },
  ] as CopilotOp[])
  assert.equal(result.applied, 1)
  const node = result.graph.nodes.find((n) => n.type === 'ai')!
  assert.equal((node.data as { aiOp: string }).aiOp, 'categorize')
  assert.deepEqual((node.data as { categories: string[] }).categories, ['Urgent', 'Routine'])
})

test('copilot can add a subflow step', () => {
  const g = emptyGraph()
  const result = applyCopilotOps(g, [
    { op: 'add', type: 'subflow', afterId: 'trigger', data: { flowId: 'child-1', inputs: { account: '{{trigger.input}}' } } },
  ] as CopilotOp[])
  assert.equal(result.applied, 1)
  const node = result.graph.nodes.find((n) => n.type === 'subflow')!
  assert.equal((node.data as { flowId: string }).flowId, 'child-1')
})

test('copilot can add wait and note steps from the complete node catalogue', () => {
  const result = applyCopilotOps(emptyGraph(), [
    { op: 'add', type: 'wait', afterId: 'trigger', data: { mode: 'duration', amount: '5', unit: 'minutes' } },
  ] as CopilotOp[])
  assert.equal(result.applied, 1)
  const wait = result.graph.nodes.find((node) => node.type === 'wait')!
  const withNote = applyCopilotOps(result.graph, [
    { op: 'add', type: 'note', afterId: wait.id, data: { text: 'Why this pause exists', color: 'blue' } },
  ] as CopilotOp[])
  assert.equal(withNote.applied, 1)
  assert.equal(withNote.graph.nodes.some((node) => node.type === 'note'), true)
})

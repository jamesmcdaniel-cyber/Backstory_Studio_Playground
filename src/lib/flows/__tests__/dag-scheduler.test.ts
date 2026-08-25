import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowEdge } from '@/lib/flows/graph'
import { buildAdjacency, edgeActivationsFor, findCycle } from '../dag-scheduler'

const e = (id: string, source: string, target: string, branch?: string): FlowEdge => ({ id, source, target, ...(branch ? { branch } : {}) })

test('buildAdjacency indexes incoming/outgoing and excludes contained nodes', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'bodyNode' }]
  const edges = [e('1', 'a', 'b'), e('2', 'a', 'c'), e('3', 'b', 'c')]
  const { incoming, outgoing, dagNodeIds } = buildAdjacency(nodes, edges, new Set(['bodyNode']))
  assert.deepEqual(dagNodeIds.sort(), ['a', 'b', 'c'])
  assert.equal(outgoing.get('a')!.length, 2)
  assert.equal(incoming.get('c')!.length, 2)
  assert.equal(incoming.get('a')!.length, 0)
})

test('buildAdjacency excludes AI configuration attachments from the data DAG', () => {
  const attachment = { id: 'cfg', source: 'model', target: 'agent', connectionType: 'ai_languageModel' as const }
  const data = { id: 'data', source: 'trigger', target: 'agent' }
  const built = buildAdjacency([{ id: 'trigger' }, { id: 'model' }, { id: 'agent' }], [attachment, data], new Set())
  assert.deepEqual(built.incoming.get('agent')?.map((edge) => edge.id), ['data'])
  assert.deepEqual(built.outgoing.get('model'), [])
})

test('edgeActivationsFor: ok fans out to all non-error edges, deads error', () => {
  const outs = [e('1', 'a', 'b'), e('2', 'a', 'err', 'error')]
  const acts = edgeActivationsFor('ok', outs)
  assert.equal(acts.get(outs[0]), 'active')
  assert.equal(acts.get(outs[1]), 'dead')
})

test('edgeActivationsFor: branch activates the chosen edge, deads the rest', () => {
  const outs = [e('1', 'c', 't', 'true'), e('2', 'c', 'f', 'false')]
  const acts = edgeActivationsFor({ branch: 'true' }, outs)
  assert.equal(acts.get(outs[0]), 'active')
  assert.equal(acts.get(outs[1]), 'dead')
})

test('edgeActivationsFor: route takes error edge if present, else normal (continue-like)', () => {
  const withErr = [e('1', 'a', 'b'), e('2', 'a', 'err', 'error')]
  const r1 = edgeActivationsFor('route', withErr)
  assert.equal(r1.get(withErr[0]), 'dead')
  assert.equal(r1.get(withErr[1]), 'active')
  const noErr = [e('1', 'a', 'b')]
  const r2 = edgeActivationsFor('route', noErr)
  assert.equal(r2.get(noErr[0]), 'active')
})

test('edgeActivationsFor: drop deads all outgoing', () => {
  const outs = [e('1', 'a', 'b'), e('2', 'a', 'c')]
  const acts = edgeActivationsFor('drop', outs)
  assert.equal(acts.get(outs[0]), 'dead')
  assert.equal(acts.get(outs[1]), 'dead')
})

test('findCycle detects a cycle and returns null for a DAG', () => {
  const out = new Map<string, FlowEdge[]>([
    ['a', [e('1', 'a', 'b')]],
    ['b', [e('2', 'b', 'c')]],
    ['c', []],
  ])
  assert.equal(findCycle(['a', 'b', 'c'], out), null)
  const cyc = new Map<string, FlowEdge[]>([
    ['a', [e('1', 'a', 'b')]],
    ['b', [e('2', 'b', 'a')]],
  ])
  assert.ok(findCycle(['a', 'b'], cyc))
})

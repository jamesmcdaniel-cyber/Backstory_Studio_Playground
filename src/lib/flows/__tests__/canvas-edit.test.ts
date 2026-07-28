import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph, FlowNode } from '@/lib/flows/graph'
import {
  canConnect,
  copySelection,
  insertNodeAt,
  insertNodeFromHandle,
  insertNodeOnEdge,
  pasteSelectionAt,
} from '@/lib/flows/mutate'
import { layoutGraph } from '@/lib/flows/layout'

const trigger: FlowNode = { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } }
const agent = (id: string, position?: { x: number; y: number }): FlowNode => ({
  id,
  type: 'agent',
  data: { agentId: 'a1', input: '' },
  ...(position ? { position } : {}),
})
const edge = (source: string, target: string, branch?: string) => ({
  id: `${source}->${target}${branch ? `:${branch}` : ''}`,
  source,
  target,
  ...(branch ? { branch } : {}),
})

const chain: FlowGraph = {
  nodes: [trigger, agent('a'), agent('b')],
  edges: [edge('trigger', 'a'), edge('a', 'b')],
}

// ── Connection validation ────────────────────────────────────────────────────

test('a legal fan-out and a legal fan-in are both allowed', () => {
  // a already goes to b; a second edge off the same step is the fan-out case.
  const withC: FlowGraph = { ...chain, nodes: [...chain.nodes, agent('c')] }
  assert.equal(canConnect(withC, 'a', 'c'), true)
  // b and c both into d is the fan-in case.
  const withD: FlowGraph = {
    nodes: [...withC.nodes, agent('d')],
    edges: [...withC.edges, edge('a', 'c'), edge('b', 'd')],
  }
  assert.equal(canConnect(withD, 'c', 'd'), true)
})

test('a self-edge, a duplicate, and an edge into the trigger are refused', () => {
  assert.equal(canConnect(chain, 'a', 'a'), false)
  assert.equal(canConnect(chain, 'a', 'b'), false)
  assert.equal(canConnect(chain, 'b', 'trigger'), false)
})

test('a connection that would loop the flow back on itself is refused', () => {
  assert.equal(canConnect(chain, 'b', 'a'), false)
})

test('a connection to a container body step is refused', () => {
  const graph: FlowGraph = {
    nodes: [
      trigger,
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', concurrency: 3, body: ['body1'] } },
      agent('body1'),
      agent('after'),
    ],
    edges: [edge('trigger', 'loop'), edge('loop', 'after')],
  }
  assert.equal(canConnect(graph, 'after', 'body1'), false)
  assert.equal(canConnect(graph, 'body1', 'after'), false)
})

// ── Position-aware insertion ─────────────────────────────────────────────────

test('a step created on the canvas keeps the position it was dropped at', () => {
  const { graph, nodeId } = insertNodeAt(chain, 'http', { x: 420, y: 96 })
  assert.deepEqual(graph.nodes.find((node) => node.id === nodeId)?.position, { x: 420, y: 96 })
  // Wired to nothing: the caller decides the connection.
  assert.equal(graph.edges.length, chain.edges.length)
})

test('a step added from a handle FANS OUT rather than replacing the existing edge', () => {
  const { graph, nodeId } = insertNodeFromHandle(chain, 'a', undefined, 'http', { x: 400, y: 200 })
  const fromA = graph.edges.filter((candidate) => candidate.source === 'a')
  assert.equal(fromA.length, 2, 'the original a→b survives alongside the new edge')
  assert.ok(fromA.some((candidate) => candidate.target === 'b'))
  assert.ok(fromA.some((candidate) => candidate.target === nodeId))
})

test('a step added from a branch handle inherits that branch', () => {
  const graph: FlowGraph = {
    nodes: [trigger, { id: 'c', type: 'condition', data: { match: 'all', clauses: [] } }],
    edges: [edge('trigger', 'c')],
  }
  const { graph: next, nodeId } = insertNodeFromHandle(graph, 'c', 'true', 'http', { x: 0, y: 0 })
  const added = next.edges.find((candidate) => candidate.target === nodeId)
  assert.equal(added?.branch, 'true')
})

test('inserting on an edge splices the step in and keeps the branch tag upstream', () => {
  const graph: FlowGraph = {
    nodes: [trigger, { id: 'c', type: 'condition', data: { match: 'all', clauses: [] } }, agent('then')],
    edges: [edge('trigger', 'c'), edge('c', 'then', 'true')],
  }
  const { graph: next, nodeId } = insertNodeOnEdge(graph, 'c->then:true', 'http', { x: 10, y: 10 })
  assert.equal(next.edges.some((candidate) => candidate.id === 'c->then:true'), false, 'original edge removed')
  const upstream = next.edges.find((candidate) => candidate.source === 'c' && candidate.target === nodeId)
  const downstream = next.edges.find((candidate) => candidate.source === nodeId && candidate.target === 'then')
  assert.equal(upstream?.branch, 'true', 'the branch stays on the upstream half')
  assert.ok(downstream, 'the new step continues to the original target')
  assert.equal(downstream?.branch, undefined)
})

test('inserting on an unknown edge is a no-op', () => {
  const { graph, nodeId } = insertNodeOnEdge(chain, 'nope', 'http', { x: 0, y: 0 })
  assert.equal(nodeId, '')
  assert.equal(graph, chain)
})

// ── Copy / paste ─────────────────────────────────────────────────────────────

test('copying keeps edges inside the selection and drops the ones crossing out', () => {
  const graph: FlowGraph = {
    nodes: [trigger, agent('a'), agent('b'), agent('c')],
    edges: [edge('trigger', 'a'), edge('a', 'b'), edge('b', 'c')],
  }
  const selection = copySelection(graph, ['a', 'b'])
  assert.deepEqual(selection.nodes.map((node) => node.id), ['a', 'b'])
  assert.deepEqual(selection.edges.map((e) => e.id), ['a->b'], 'b→c crossed the boundary')
})

test('the trigger and container body steps are never copyable', () => {
  const graph: FlowGraph = {
    nodes: [
      trigger,
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', concurrency: 3, body: ['body1'] } },
      agent('body1'),
    ],
    edges: [edge('trigger', 'loop')],
  }
  const selection = copySelection(graph, ['trigger', 'loop', 'body1'])
  assert.deepEqual(selection.nodes.map((node) => node.id), ['loop'])
})

test('pasting remaps ids, keeps internal wiring, and anchors at the drop point', () => {
  const graph: FlowGraph = {
    nodes: [trigger, agent('a', { x: 0, y: 0 }), agent('b', { x: 300, y: 40 })],
    edges: [edge('trigger', 'a'), edge('a', 'b')],
  }
  const selection = copySelection(graph, ['a', 'b'])
  const { graph: next, nodeIds } = pasteSelectionAt(graph, selection, { x: 1000, y: 500 })

  assert.equal(nodeIds.length, 2)
  assert.equal(nodeIds.includes('a'), false, 'ids are fresh, not the originals')
  const pasted = nodeIds.map((id) => next.nodes.find((node) => node.id === id)!)
  // The selection's top-left lands on the drop point; internal offsets survive.
  assert.deepEqual(pasted[0].position, { x: 1000, y: 500 })
  assert.deepEqual(pasted[1].position, { x: 1300, y: 540 })
  // The internal a→b edge is remapped onto the new ids...
  assert.ok(next.edges.some((e) => e.source === nodeIds[0] && e.target === nodeIds[1]))
  // ...and nothing new attaches to the original graph.
  assert.equal(next.edges.filter((e) => e.target === 'a' || e.target === 'b').length, 2)
})

test('pasting a container gives it an empty body rather than sharing the original', () => {
  const graph: FlowGraph = {
    nodes: [
      trigger,
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', concurrency: 3, body: ['body1'] } },
      agent('body1'),
    ],
    edges: [edge('trigger', 'loop')],
  }
  const { graph: next, nodeIds } = pasteSelectionAt(graph, copySelection(graph, ['loop']), { x: 0, y: 0 })
  const pasted = next.nodes.find((node) => node.id === nodeIds[0])
  assert.equal(pasted?.type, 'loop')
  assert.deepEqual(pasted?.type === 'loop' ? pasted.data.body : null, [])
})

test('pasting an empty selection is a no-op', () => {
  const { graph, nodeIds } = pasteSelectionAt(chain, { nodes: [], edges: [] }, { x: 0, y: 0 })
  assert.deepEqual(nodeIds, [])
  assert.equal(graph, chain)
})

// ── Layout ───────────────────────────────────────────────────────────────────

test('layout honors a persisted position, and "tidy up" overrides it', () => {
  const arranged: FlowGraph = {
    nodes: [trigger, agent('a', { x: 999, y: 777 })],
    edges: [edge('trigger', 'a')],
  }
  assert.deepEqual(layoutGraph(arranged).get('a'), { x: 999, y: 777 })
  const tidied = layoutGraph(arranged, { force: true }).get('a')
  assert.notDeepEqual(tidied, { x: 999, y: 777 })
})

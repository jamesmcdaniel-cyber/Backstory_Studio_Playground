import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph, FlowNode } from '@/lib/flows/graph'
import {
  baseHandleId,
  edgeRunStates,
  freePosition,
  hasTargetHandle,
  isLinearRenderable,
  outerEdges,
  outerNodes,
  placeDownstreamOf,
  plusHandleId,
  sourceHandleOf,
  sourceHandlesFor,
  unreachableInlineIds,
  NODE_HEIGHT,
  NODE_WIDTH,
} from '@/lib/flows/canvas-model'

const trigger: FlowNode = { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } }
const agent = (id: string): FlowNode => ({ id, type: 'agent', data: { agentId: 'a1', input: '' } })
const edge = (source: string, target: string, branch?: string) => ({
  id: `${source}->${target}${branch ? `:${branch}` : ''}`,
  source,
  target,
  ...(branch ? { branch } : {}),
})

/** trigger → a → b */
const chain: FlowGraph = {
  nodes: [trigger, agent('a'), agent('b')],
  edges: [edge('trigger', 'a'), edge('a', 'b')],
}

/** trigger → a → {b, c} → d (the fan-out/fan-in the inline view cannot draw) */
const diamond: FlowGraph = {
  nodes: [trigger, agent('a'), agent('b'), agent('c'), agent('d')],
  edges: [edge('trigger', 'a'), edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')],
}

test('every step takes an incoming edge except the trigger', () => {
  assert.equal(hasTargetHandle(trigger), false)
  assert.equal(hasTargetHandle(agent('a')), true)
})

test('a plain step has one source handle', () => {
  const handles = sourceHandlesFor(agent('a'))
  assert.deepEqual(handles.map((handle) => handle.id), ['out'])
})

test('a condition exposes one handle per branch', () => {
  const condition: FlowNode = { id: 'c', type: 'condition', data: { match: 'all', clauses: [] } }
  assert.deepEqual(sourceHandlesFor(condition).map((handle) => handle.id), ['true', 'false'])
})

test('a switch exposes one handle per case plus a default', () => {
  const node: FlowNode = {
    id: 's',
    type: 'switch',
    data: { cases: [{ id: 'case1', left: 'x', op: 'eq', right: '1' }, { id: 'case2', left: 'x', op: 'eq', right: '2' }] },
  }
  assert.deepEqual(sourceHandlesFor(node).map((handle) => handle.id), ['case1', 'case2', 'default'])
})

test('a step routing on failure gains an error handle alongside its normal one', () => {
  const node: FlowNode = { id: 'h', type: 'http', data: { method: 'GET', url: 'https://x', onError: 'route' } }
  const handles = sourceHandlesFor(node)
  assert.deepEqual(handles.map((handle) => handle.id), ['out', 'error'])
  assert.equal(handles[1].tone, 'error')
})

test('a stop step offers no outgoing handle', () => {
  const stop: FlowNode = { id: 'stop', type: 'stop', data: { reason: '' } }
  assert.deepEqual(sourceHandlesFor(stop), [])
})

test('an edge leaves the handle named by its branch, or "out" when plain', () => {
  assert.equal(sourceHandleOf(edge('a', 'b')), 'out')
  assert.equal(sourceHandleOf(edge('c', 'b', 'true')), 'true')
})

test('a `+` stub handle round-trips to the source handle it stands in for', () => {
  assert.equal(baseHandleId(plusHandleId('out')), 'out')
  assert.equal(baseHandleId(plusHandleId('true')), 'true')
  assert.equal(baseHandleId(plusHandleId('error')), 'error')
  // A plain handle id passes through untouched.
  assert.equal(baseHandleId('out'), 'out')
  assert.equal(baseHandleId('case1'), 'case1')
})

test('container body steps are excluded from the canvas graph', () => {
  const graph: FlowGraph = {
    nodes: [
      trigger,
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', concurrency: 3, body: ['body1'] } },
      agent('body1'),
      agent('after'),
    ],
    edges: [edge('trigger', 'loop'), edge('loop', 'after'), edge('body1', 'after')],
  }
  assert.deepEqual(outerNodes(graph).map((node) => node.id), ['trigger', 'loop', 'after'])
  // The edge touching the body step is not drawable either.
  assert.deepEqual(outerEdges(graph).map((e) => e.id), ['trigger->loop', 'loop->after'])
})

test('a chain is inline-renderable but a diamond is not', () => {
  assert.equal(isLinearRenderable(chain), true)
  assert.equal(isLinearRenderable(diamond), false)
})

test('a step with two incoming edges is not inline-renderable', () => {
  const fanIn: FlowGraph = {
    nodes: [trigger, agent('a'), agent('b'), agent('join')],
    edges: [edge('trigger', 'a'), edge('trigger', 'b'), edge('a', 'join'), edge('b', 'join')],
  }
  assert.equal(isLinearRenderable(fanIn), false)
})

test('a step the chain walk never reaches is reported, not hidden', () => {
  const orphaned: FlowGraph = {
    nodes: [trigger, agent('a'), agent('orphan')],
    edges: [edge('trigger', 'a')],
  }
  assert.deepEqual(unreachableInlineIds(orphaned), ['orphan'])
  assert.equal(isLinearRenderable(orphaned), false)
})

test('a fan-out path the chain drops on the floor is reported, not silently hidden', () => {
  // The walk follows only a→b, so c and everything past it goes unrendered.
  assert.deepEqual(unreachableInlineIds(diamond), ['c'])
})

test('a branch head is reachable inline — branches render as their own columns', () => {
  const branching: FlowGraph = {
    nodes: [trigger, { id: 'c', type: 'condition', data: { match: 'all', clauses: [] } }, agent('then'), agent('other')],
    edges: [edge('trigger', 'c'), edge('c', 'then', 'true'), edge('c', 'other', 'false')],
  }
  assert.deepEqual(unreachableInlineIds(branching), [])
  assert.equal(isLinearRenderable(branching), true)
})

test('run state marks the taken path succeeded and the untaken branch dead', () => {
  const states = edgeRunStates(diamond, { trigger: 'succeeded', a: 'succeeded', b: 'succeeded', c: 'skipped' })
  assert.equal(states.get('a->b'), 'succeeded')
  assert.equal(states.get('a->c'), 'dead')
  // d never ran, so nothing downstream is claimed to have carried a value.
  assert.equal(states.get('b->d'), 'idle')
})

test('the edge into a failed step goes red, and paths out of it go dead', () => {
  const states = edgeRunStates(diamond, { trigger: 'succeeded', a: 'succeeded', b: 'failed', c: 'skipped' })
  assert.equal(states.get('a->b'), 'failed')
  assert.equal(states.get('a->c'), 'dead')
  // b never delivered a value downstream, so its outgoing edge is a cut path,
  // not an idle one — the canvas shows exactly where the run stopped.
  assert.equal(states.get('b->d'), 'dead')
})

test('an edge into an in-flight step animates as running', () => {
  const states = edgeRunStates(diamond, { trigger: 'succeeded', a: 'succeeded', b: 'running' })
  assert.equal(states.get('a->b'), 'running')
  assert.equal(states.get('b->d'), 'idle')
})

test('an error route lights up only when its source actually failed', () => {
  const routed: FlowGraph = {
    nodes: [trigger, agent('a'), agent('rescue'), agent('next')],
    edges: [edge('trigger', 'a'), edge('a', 'rescue', 'error'), edge('a', 'next')],
  }
  const taken = edgeRunStates(routed, { trigger: 'succeeded', a: 'failed', rescue: 'succeeded' })
  assert.equal(taken.get('a->rescue:error'), 'succeeded')
  assert.equal(taken.get('a->next'), 'dead')

  const untaken = edgeRunStates(routed, { trigger: 'succeeded', a: 'succeeded', next: 'succeeded' })
  assert.equal(untaken.get('a->rescue:error'), 'dead')
  assert.equal(untaken.get('a->next'), 'succeeded')

  // While the source is still in flight the route's fate is unknown.
  const inFlight = edgeRunStates(routed, { trigger: 'succeeded', a: 'running' })
  assert.equal(inFlight.get('a->rescue:error'), 'idle')
})

test('a new step is nudged clear of whatever already occupies the spot', () => {
  const taken = { x: 100, y: 100 }
  const free = freePosition(taken, [taken])
  assert.equal(free.x, taken.x)
  assert.ok(free.y >= taken.y + NODE_HEIGHT, 'nudged below the occupied box')
  // An empty column is left exactly where asked.
  assert.deepEqual(freePosition(taken, []), taken)
})

test('a downstream step lands one column right of its source', () => {
  const positions = new Map([['a', { x: 0, y: 0 }]])
  const placed = placeDownstreamOf('a', positions)
  assert.ok(placed.x >= NODE_WIDTH, 'clear of the source node')
  assert.equal(placed.y, 0)
})

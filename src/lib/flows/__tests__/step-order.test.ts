import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stepOrder } from '@/lib/flows/step-order'
import type { FlowGraph, FlowNode } from '@/lib/flows/graph'

const http = (id: string): FlowNode => ({ id, type: 'http', data: { url: '', method: 'GET' } }) as FlowNode
const trigger = (): FlowNode => ({ id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } }) as FlowNode
const edge = (source: string, target: string) => ({ id: `${source}->${target}`, source, target })

test('stepOrder follows the edges, not the node array order', () => {
  // "b" was inserted on the trigger→a edge, so it sits LAST in the array while
  // running second — the case that makes array order unusable for navigation.
  const graph: FlowGraph = {
    nodes: [trigger(), http('a'), http('b')],
    edges: [edge('trigger', 'b'), edge('b', 'a')],
  }
  assert.deepEqual(stepOrder(graph), ['trigger', 'b', 'a'])
})

test('stepOrder walks each branch to its end, in edge declaration order', () => {
  const graph: FlowGraph = {
    nodes: [trigger(), http('split'), http('left'), http('leftEnd'), http('right')],
    edges: [
      edge('trigger', 'split'),
      edge('split', 'left'),
      edge('left', 'leftEnd'),
      edge('split', 'right'),
    ],
  }
  assert.deepEqual(stepOrder(graph), ['trigger', 'split', 'left', 'leftEnd', 'right'])
})

test('stepOrder omits container body steps and survives cycles', () => {
  const graph: FlowGraph = {
    nodes: [
      trigger(),
      { id: 'loop', type: 'loop', data: { over: '', body: ['inner'] } } as FlowNode,
      http('inner'),
      http('after'),
    ],
    edges: [edge('trigger', 'loop'), edge('loop', 'after'), edge('after', 'loop')],
  }
  // "inner" is edited inside the loop's own drawer, so it is not a stop on the
  // outer walk; the after→loop edge must not re-visit anything.
  assert.deepEqual(stepOrder(graph), ['trigger', 'loop', 'after'])
})

test('stepOrder still lists steps the trigger cannot reach', () => {
  const graph: FlowGraph = {
    nodes: [trigger(), http('wired'), http('orphan')],
    edges: [edge('trigger', 'wired')],
  }
  assert.deepEqual(stepOrder(graph), ['trigger', 'wired', 'orphan'])
})

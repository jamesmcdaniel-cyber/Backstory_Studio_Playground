import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { FlowCanvas } from '@/components/flows/flow-canvas'
import type { FlowGraph, FlowNode } from '@/lib/flows/graph'

/**
 * The inline chain walks ONE plain successor per step, so a fan-out leaves
 * whole paths unrendered. It must SAY so and still list every step — a step
 * that silently disappears from the builder is indistinguishable from a step
 * that was deleted.
 */

const trigger: FlowNode = { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } }
const agent = (id: string, label: string): FlowNode => ({ id, type: 'agent', data: { agentId: 'a1', input: '', label } })
const edge = (source: string, target: string) => ({ id: `${source}->${target}`, source, target })

function renderCanvas(graph: FlowGraph) {
  return render(
    React.createElement(FlowCanvas, {
      graph,
      agentName: () => 'Agent',
      agents: [],
      toolCatalog: [],
      statusByNode: {},
      selectedId: null,
      onSelect: () => {},
      onChangeNode: () => {},
      onInsertAfter: () => {},
      onAppendBranch: () => {},
    }),
  )
}

test('a linear flow shows no parallel-paths warning', (t) => {
  t.after(cleanup)
  const graph: FlowGraph = {
    nodes: [trigger, agent('a', 'First step'), agent('b', 'Second step')],
    edges: [edge('trigger', 'a'), edge('a', 'b')],
  }
  const { container } = renderCanvas(graph)
  assert.doesNotMatch(container.textContent ?? '', /parallel paths/)
  assert.doesNotMatch(container.textContent ?? '', /Also in this flow/)
})

test('an unreachable step is named in the banner list rather than hidden', (t) => {
  t.after(cleanup)
  const graph: FlowGraph = {
    nodes: [trigger, agent('a', 'First step'), agent('orphan', 'Stranded step')],
    edges: [edge('trigger', 'a')],
  }
  const { container } = renderCanvas(graph)
  assert.match(container.textContent ?? '', /parallel paths/)
  assert.match(container.textContent ?? '', /Also in this flow/)
  assert.match(container.textContent ?? '', /Stranded step/)
})

test('every step of a fan-out flow is still rendered somewhere', (t) => {
  t.after(cleanup)
  // trigger → a → {b, c}: the chain draws one branch, the banner list the other.
  const graph: FlowGraph = {
    nodes: [trigger, agent('a', 'Split here'), agent('b', 'Left path'), agent('c', 'Right path')],
    edges: [edge('trigger', 'a'), edge('a', 'b'), edge('a', 'c')],
  }
  const { container } = renderCanvas(graph)
  const text = container.textContent ?? ''
  assert.match(text, /Split here/)
  assert.match(text, /Left path/)
  assert.match(text, /Right path/, 'the second fan-out path is still reachable in the UI')
})

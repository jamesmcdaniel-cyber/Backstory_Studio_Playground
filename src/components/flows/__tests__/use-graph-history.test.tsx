import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { render, cleanup } from '@testing-library/react'
import { useGraphHistory, type GraphHistoryHandle } from '@/components/flows/use-graph-history'
import type { FlowGraph, FlowNode } from '@/lib/flows/graph'

/**
 * The 600ms field-edit burst — the one genuinely effectful part of the flow
 * editor's undo/redo, and the reason it lived in the page component with no
 * test. The reducer's rules are covered in
 * src/lib/flows/__tests__/graph-history.test.ts; this covers the timer that
 * decides where one edit ends and the next begins.
 */

const node = (id: string, prompt: string): FlowNode =>
  ({ id, type: 'ai', data: { instructions: prompt } } as unknown as FlowNode)

const graphWith = (...nodes: FlowNode[]): FlowGraph =>
  ({ nodes, edges: [] } as unknown as FlowGraph)

/** Render the hook and expose its latest value. */
function mount(initial: FlowGraph) {
  const ref: { current: GraphHistoryHandle | null } = { current: null }
  function Probe() {
    ref.current = useGraphHistory(initial)
    return null
  }
  render(<Probe />)
  return ref as { current: GraphHistoryHandle }
}

const promptOf = (handle: GraphHistoryHandle, id: string) =>
  (handle.graph.nodes.find((n) => n.id === id)?.data as { instructions?: string } | undefined)?.instructions

test('a burst of keystrokes collapses into ONE undo step', async (t) => {
  t.after(cleanup)
  const start = graphWith(node('n1', ''))
  const handle = mount(start)

  // Three characters typed inside the burst window.
  await act(async () => { handle.current.commitFieldEdit(node('n1', 'h')) })
  await act(async () => { handle.current.commitFieldEdit(node('n1', 'hi')) })
  await act(async () => { handle.current.commitFieldEdit(node('n1', 'hey')) })
  assert.equal(promptOf(handle.current, 'n1'), 'hey')
  assert.equal(handle.current.canUndo, true)

  // One ⌘Z returns to the text as it stood before typing started — not to 'hi'.
  await act(async () => { handle.current.undo() })
  assert.equal(promptOf(handle.current, 'n1'), '')
  assert.equal(handle.current.canUndo, false, 'the whole burst was a single step')
})

test('typing again after the burst window is a SECOND undo step', async (t) => {
  t.after(cleanup)
  const handle = mount(graphWith(node('n1', '')))

  await act(async () => { handle.current.commitFieldEdit(node('n1', 'first')) })
  // Let the burst close the way a pause in typing would.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })
  await act(async () => { handle.current.commitFieldEdit(node('n1', 'first second')) })

  await act(async () => { handle.current.undo() })
  assert.equal(promptOf(handle.current, 'n1'), 'first', 'the pause should have ended the first edit')
  await act(async () => { handle.current.undo() })
  assert.equal(promptOf(handle.current, 'n1'), '')
})

test('a structural edit is its own step, and redo comes back to it', async (t) => {
  t.after(cleanup)
  const handle = mount(graphWith(node('n1', 'a')))

  await act(async () => { handle.current.commitGraph(graphWith(node('n1', 'a'), node('n2', 'b'))) })
  assert.equal(handle.current.graph.nodes.length, 2)

  await act(async () => { handle.current.undo() })
  assert.equal(handle.current.graph.nodes.length, 1)
  assert.equal(handle.current.canRedo, true)

  await act(async () => { handle.current.redo() })
  assert.equal(handle.current.graph.nodes.length, 2)
})

test('a remote co-editor broadcast is not undoable', async (t) => {
  t.after(cleanup)
  const handle = mount(graphWith(node('n1', 'mine')))

  await act(async () => { handle.current.replaceGraph(graphWith(node('n1', 'theirs'))) })
  assert.equal(promptOf(handle.current, 'n1'), 'theirs')
  assert.equal(
    handle.current.canUndo,
    false,
    'undoing into a co-editor’s discarded state would silently overwrite their work',
  )
})

test('loading a flow clears whatever history the previous one had', async (t) => {
  t.after(cleanup)
  const handle = mount(graphWith(node('n1', 'a')))
  await act(async () => { handle.current.commitGraph(graphWith(node('n1', 'b'))) })
  assert.equal(handle.current.canUndo, true)

  await act(async () => { handle.current.resetGraph(graphWith(node('other', 'x'))) })
  assert.equal(handle.current.canUndo, false)
  assert.equal(handle.current.canRedo, false)
})

test('applyToGraph sees the LATEST graph, not one captured at mount', async (t) => {
  t.after(cleanup)
  const handle = mount(graphWith(node('n1', 'a')))
  await act(async () => { handle.current.commitGraph(graphWith(node('n1', 'a'), node('n2', 'b'))) })

  // How mock-data pinning works: it reads whatever is on the canvas now.
  await act(async () => {
    handle.current.applyToGraph((graph) => ({ ...graph, pinData: { n2: { ok: true } } }) as FlowGraph)
  })
  assert.equal(handle.current.graph.nodes.length, 2, 'the pin must not revert a concurrent edit')
  assert.deepEqual((handle.current.graph as { pinData?: unknown }).pinData, { n2: { ok: true } })
})

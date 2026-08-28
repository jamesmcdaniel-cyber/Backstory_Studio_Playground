import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HISTORY_LIMIT,
  canRedo,
  canUndo,
  graphHistoryReducer as reduce,
  initialGraphHistory,
} from '@/lib/flows/graph-history'
import type { FlowGraph } from '@/lib/flows/graph'

/**
 * The flow editor's undo/redo, which lived as two useRefs inside a 3,285-line
 * page component and had no tests at all — refs are invisible to a render-based
 * test, so none of the rules below were ever checked.
 */

/** A graph is only ever compared by identity here, so a marker is enough. */
const g = (name: string): FlowGraph => ({ nodes: [{ id: name }], edges: [] } as unknown as FlowGraph)

const A = g('a'), B = g('b'), C = g('c'), D = g('d')

test('a checkpoint moves to the new graph and makes the old one undoable', () => {
  const state = reduce(initialGraphHistory(A), { type: 'checkpoint', graph: B })
  assert.equal(state.present, B)
  assert.equal(canUndo(state), true)
  assert.equal(canRedo(state), false)
})

test('undo returns the previous graph and offers it back as redo', () => {
  let s = reduce(initialGraphHistory(A), { type: 'checkpoint', graph: B })
  s = reduce(s, { type: 'undo' })
  assert.equal(s.present, A)
  assert.equal(canRedo(s), true)
  s = reduce(s, { type: 'redo' })
  assert.equal(s.present, B)
  assert.equal(canRedo(s), false)
})

test('a new edit after an undo discards the redo future', () => {
  // The future it pointed at is no longer reachable from here, and leaving it
  // would let a later ⌘⇧Z jump to a graph that never followed this one.
  let s = reduce(initialGraphHistory(A), { type: 'checkpoint', graph: B })
  s = reduce(s, { type: 'undo' })
  assert.equal(canRedo(s), true)
  s = reduce(s, { type: 'checkpoint', graph: C })
  assert.equal(canRedo(s), false)
  assert.equal(s.present, C)
})

test('undo at the beginning and redo at the end are no-ops, not crashes', () => {
  const start = initialGraphHistory(A)
  assert.equal(reduce(start, { type: 'undo' }), start)
  assert.equal(reduce(start, { type: 'redo' }), start)
})

test('committing the same graph does not consume an undo slot', () => {
  // With a bounded stack, no-op edits would otherwise push every real
  // checkpoint out of reach.
  const start = reduce(initialGraphHistory(A), { type: 'checkpoint', graph: B })
  assert.equal(reduce(start, { type: 'checkpoint', graph: B }), start)
})

test('the history cap drops the OLDEST entry, so the newest edits stay undoable', () => {
  let s = initialGraphHistory(g('0'))
  for (let i = 1; i <= HISTORY_LIMIT + 10; i += 1) s = reduce(s, { type: 'checkpoint', graph: g(String(i)) })
  assert.equal(s.past.length, HISTORY_LIMIT)

  // One undo must reach the immediately preceding edit — a cap that dropped the
  // newest entry would leave the most recent change permanently un-undoable.
  const back = reduce(s, { type: 'undo' })
  assert.deepEqual(back.present, g(String(HISTORY_LIMIT + 9)))
})

test('replace changes the graph without creating an undo step', () => {
  // A co-editor's broadcast and a version revert are not edits this user made;
  // making them undoable would let ⌘Z resurrect someone else's discarded state.
  const s = reduce(initialGraphHistory(A), { type: 'replace', graph: B })
  assert.equal(s.present, B)
  assert.equal(canUndo(s), false)
})

test('apply updates against the LATEST graph rather than a captured one', () => {
  // Pinning mock data reads the current graph; capturing it at callback-creation
  // time would silently drop concurrent edits.
  let s = reduce(initialGraphHistory(A), { type: 'checkpoint', graph: B })
  s = reduce(s, { type: 'apply', update: (graph) => { assert.equal(graph, B); return C } })
  assert.equal(s.present, C)
  assert.equal(s.past.length, 1, 'apply must not add a checkpoint')
})

test('reset clears the history, so a freshly loaded flow has nothing behind it', () => {
  let s = reduce(initialGraphHistory(A), { type: 'checkpoint', graph: B })
  s = reduce(s, { type: 'undo' })
  s = reduce(s, { type: 'reset', graph: D })
  assert.equal(s.present, D)
  assert.equal(canUndo(s), false)
  assert.equal(canRedo(s), false)
})

test('redo re-checkpoints, so undo immediately after it goes back again', () => {
  let s = reduce(initialGraphHistory(A), { type: 'checkpoint', graph: B })
  s = reduce(s, { type: 'undo' })
  s = reduce(s, { type: 'redo' })
  s = reduce(s, { type: 'undo' })
  assert.equal(s.present, A)
})

test('checkpointApply preserves the graph as it was BEFORE the edit', () => {
  // The first keystroke of a field-edit burst. Undo must land on the text as it
  // stood before typing started, not on the state after the first character.
  let s = reduce(initialGraphHistory(A), { type: 'checkpoint', graph: B })
  s = reduce(s, { type: 'checkpointApply', update: () => C })
  assert.equal(s.present, C)
  assert.equal(reduce(s, { type: 'undo' }).present, B)
})

test('a burst is ONE undo step: checkpointApply once, then apply', () => {
  // What the 600ms burst window buys: ⌘Z rolls back the whole edit rather than
  // one character of it.
  let s = initialGraphHistory(A)
  s = reduce(s, { type: 'checkpointApply', update: () => B })   // first keystroke
  s = reduce(s, { type: 'apply', update: () => C })             // ...rest of the burst
  s = reduce(s, { type: 'apply', update: () => D })
  assert.equal(s.present, D)
  assert.equal(reduce(s, { type: 'undo' }).present, A)
})

test('checkpointApply also invalidates redo', () => {
  let s = reduce(initialGraphHistory(A), { type: 'checkpoint', graph: B })
  s = reduce(s, { type: 'undo' })
  assert.equal(canRedo(s), true)
  s = reduce(s, { type: 'checkpointApply', update: () => C })
  assert.equal(canRedo(s), false)
})

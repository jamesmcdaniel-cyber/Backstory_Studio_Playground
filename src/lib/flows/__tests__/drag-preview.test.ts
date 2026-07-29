import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyDragPreview, pruneDragPreview } from '../drag-preview'

test('a drag event records the node position and the newest wins', () => {
  const first = applyDragPreview({}, { nodeId: 'n1', x: 10, y: 20 }, 1_000)
  assert.deepEqual(first.n1, { x: 10, y: 20, ts: 1_000 })
  const moved = applyDragPreview(first, { nodeId: 'n1', x: 30, y: 40 }, 1_100)
  assert.deepEqual(moved.n1, { x: 30, y: 40, ts: 1_100 })
})

test('a drag END clears the node so the committed graph position takes over', () => {
  const dragging = applyDragPreview({}, { nodeId: 'n1', x: 10, y: 20 }, 1_000)
  assert.deepEqual(applyDragPreview(dragging, { nodeId: 'n1', done: true }, 1_200), {})
})

test('a malformed packet clears rather than pins the node', () => {
  const dragging = applyDragPreview({}, { nodeId: 'n1', x: 10, y: 20 }, 1_000)
  assert.deepEqual(applyDragPreview(dragging, { nodeId: 'n1' }, 1_200), {})
})

test('a preview whose sender vanished mid-drag expires instead of pinning the node', () => {
  const dragging = applyDragPreview({}, { nodeId: 'n1', x: 1, y: 1 }, 1_000)
  assert.deepEqual(pruneDragPreview(dragging, 1_500), dragging)
  assert.deepEqual(pruneDragPreview(dragging, 5_000), {})
})

test('pruning returns the same object when nothing expired, so React can skip the render', () => {
  const dragging = applyDragPreview({}, { nodeId: 'n1', x: 1, y: 1 }, 1_000)
  assert.equal(pruneDragPreview(dragging, 1_100), dragging)
})

test('other nodes are untouched when one drag ends', () => {
  let state = applyDragPreview({}, { nodeId: 'n1', x: 1, y: 1 }, 1_000)
  state = applyDragPreview(state, { nodeId: 'n2', x: 5, y: 5 }, 1_000)
  const after = applyDragPreview(state, { nodeId: 'n1', done: true }, 1_050)
  assert.deepEqual(Object.keys(after), ['n2'])
})

export type DragPreview = Record<string, { x: number; y: number; ts: number }>
export type DragPreviewEvent = { nodeId: string; x?: number; y?: number; done?: boolean }

/**
 * Ephemeral positions for nodes a TEAMMATE is currently dragging. Node moves
 * only reach the room when the drag ends, so a teammate's node used to teleport
 * across the canvas; these previews make the movement visible in between.
 *
 * They never enter the graph or the undo history — the op broadcast on release
 * is what commits — so a dropped `done` packet can leave a stale ghost for the
 * TTL at worst, never a corrupted graph.
 */
export function applyDragPreview(state: DragPreview, event: DragPreviewEvent, now: number): DragPreview {
  const next = { ...state }
  if (event.done || typeof event.x !== 'number' || typeof event.y !== 'number') {
    delete next[event.nodeId]
    return next
  }
  next[event.nodeId] = { x: event.x, y: event.y, ts: now }
  return next
}

/** Expire previews from a client that vanished mid-drag. Returns the same
 *  object when nothing expired so a render can be skipped. */
export function pruneDragPreview(state: DragPreview, now: number, ttlMs = 3_000): DragPreview {
  const entries = Object.entries(state).filter(([, value]) => now - value.ts <= ttlMs)
  return entries.length === Object.keys(state).length ? state : Object.fromEntries(entries)
}

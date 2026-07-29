/**
 * Which builder view a cursor's coordinates belong to. Inline lays steps out in
 * document-flow pixels and Canvas in DAG positions — the same (x, y) means two
 * different places, so a cursor is only drawn for viewers on the same view.
 */
export type CursorSpace = 'inline' | 'canvas'

export type RemoteCursor = {
  clientId: string
  x: number
  y: number
  name: string
  color: string
  /** Coordinate system these x/y belong to. Packets without one are inline. */
  space: CursorSpace
  /** Local receipt time (ms) — idle cursors fade out via pruneCursors. */
  ts: number
}

/** Upsert by clientId — the latest position wins; new clients append. */
export function upsertCursor(list: RemoteCursor[], incoming: RemoteCursor): RemoteCursor[] {
  const index = list.findIndex((c) => c.clientId === incoming.clientId)
  if (index === -1) return [...list, incoming]
  const next = list.slice()
  next[index] = incoming
  return next
}

/**
 * Drop cursors idle past the TTL, and — only when presence is actually known —
 * those whose client has left the room. An empty or absent presence set means
 * "we don't know yet", NOT "everyone left": gating on it unconditionally meant
 * a single presence hiccup erased every cursor on screen while packets kept
 * arriving, which read as "cursors don't work".
 */
export function pruneCursors(
  list: RemoteCursor[],
  now: number,
  presentClientIds: Set<string> | null,
  ttlMs = 5_000,
): RemoteCursor[] {
  const gate = presentClientIds && presentClientIds.size > 0 ? presentClientIds : null
  const kept = list.filter((c) => now - c.ts <= ttlMs && (!gate || gate.has(c.clientId)))
  return kept.length === list.length ? list : kept
}

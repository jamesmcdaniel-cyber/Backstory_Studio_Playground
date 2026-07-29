import type { CursorSpace } from './cursor-store'

/**
 * Inline lays steps out in document pixels and Canvas in DAG coordinates, so a
 * cursor is only drawable for viewers on the same view. Silently hiding a
 * teammate in the other view read as "cursors are broken" — presence now
 * carries the view, the roster says where they are, and one click joins them.
 * Packets from clients that predate the field are assumed to be co-located.
 */
export function describeParticipantView(
  participant: { view?: CursorSpace },
  myView: CursorSpace,
): { label: string; needsFollow: boolean } {
  const view = participant.view
  if (!view || view === myView) return { label: '', needsFollow: false }
  return { label: view === 'canvas' ? 'Canvas view' : 'Inline view', needsFollow: true }
}

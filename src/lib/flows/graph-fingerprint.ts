import { createHash } from 'node:crypto'

/**
 * A stable digest of a flow graph, for "is this the same draft that was
 * approved".
 *
 * Key order in stored JSON is whatever the writer produced, so the digest is
 * taken over a canonical form — otherwise a save that changed nothing but the
 * serialization order would read as an edit and invalidate a review that is
 * still perfectly valid.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    )
  }
  return value
}

export function graphFingerprint(graph: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(graph) ?? null)).digest('hex')
}

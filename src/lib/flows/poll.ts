/**
 * Pure dedupe logic for the polling trigger. A poll runs a read-tool on a
 * schedule; this decides which returned items are NEW since the last poll,
 * against a bounded "seen keys" cursor stored on the flow. The first poll
 * establishes a baseline and emits nothing (so activating a flow doesn't flood
 * on every pre-existing record) — matching n8n's poll-trigger semantics.
 */

export type PollCursor = { seen: string[] }

/** Keep the cursor bounded so a high-volume source can't grow it without limit. */
const MAX_SEEN = 1000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))

/** A stable identity for an item: its `dedupeKey` field, else a hash of the item. */
export function pollItemKey(item: unknown, dedupeKey: string): string {
  if (isRecord(item)) {
    const raw = item[dedupeKey.trim() || 'id']
    if (raw !== undefined && raw !== null) return String(raw)
  }
  // Deterministic fallback hash (djb2 over the JSON) — no key field present.
  const text = typeof item === 'string' ? item : JSON.stringify(item)
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  return `h${(hash >>> 0).toString(36)}`
}

export function newPollItems(
  items: unknown[],
  dedupeKey: string,
  cursor: PollCursor | undefined,
): { fresh: unknown[]; nextCursor: PollCursor } {
  const currentKeys = items.map((item) => pollItemKey(item, dedupeKey))
  // First poll: baseline only — record every current key, emit nothing.
  if (!cursor) {
    return { fresh: [], nextCursor: { seen: currentKeys.slice(-MAX_SEEN) } }
  }
  const seen = new Set(cursor.seen)
  const fresh = items.filter((_, index) => !seen.has(currentKeys[index]))
  // Retain the most recent keys: prior seen followed by this poll's keys, capped.
  const merged = [...cursor.seen, ...currentKeys.filter((key) => !seen.has(key))]
  return { fresh, nextCursor: { seen: merged.slice(-MAX_SEEN) } }
}

/**
 * The last poll's failure, when the most recent check failed — what the
 * builder shows so a poll that never fires says why. Null once a check succeeds.
 */
export function pollFailure(pollCursor: unknown): { message: string; at: string } | null {
  if (!pollCursor || typeof pollCursor !== 'object' || Array.isArray(pollCursor)) return null
  const raw = (pollCursor as { lastError?: unknown }).lastError
  if (!raw || typeof raw !== 'object') return null
  const { message, at } = raw as { message?: unknown; at?: unknown }
  return typeof message === 'string' && typeof at === 'string' ? { message, at } : null
}

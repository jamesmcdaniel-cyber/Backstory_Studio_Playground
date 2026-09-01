/**
 * Pure decision logic for filling a NULL `embeddingVec`, shared by the ops
 * script (scripts/reembed-backfill.ts) and the scheduled sweep
 * (src/lib/knowledge/reembed-sweep.ts). No DB, no network.
 *
 * Extracted rather than duplicated: the two callers must agree on when a
 * legacy vector is usable, or the sweep and the backfill would disagree about
 * which rows still need work.
 */

import { EMBEDDING_DIM } from './embeddings'

export type RowAction = 'convert' | 'reembed' | 'skip'

export interface BackfillRow {
  id: string
  /** Text to send to the embedding provider if a re-embed is needed. */
  text: string
  /** The legacy Json column's current value (already JSON-parsed). */
  legacyEmbedding: unknown
}

/** A legacy `embedding Json?` value is usable iff it's a number[] of exactly `dim` finite numbers. */
export function isValidLegacyVector(value: unknown, dim: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === dim &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  )
}

/** Decide what one row needs, preferring a free legacy conversion over a paid re-embed. */
export function decideAction(row: BackfillRow, dim: number = EMBEDDING_DIM): RowAction {
  if (isValidLegacyVector(row.legacyEmbedding, dim)) return 'convert'
  if (row.text.trim().length > 0) return 'reembed'
  return 'skip'
}

/** Split items into stable, order-preserving batches of at most `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk size must be positive')
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Rough token estimate for a cost preview (~4 chars/token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

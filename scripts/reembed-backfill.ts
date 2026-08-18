/**
 * Backfill the pgvector `embeddingVec` column from the legacy `embedding Json?`
 * column (or, when no usable legacy value exists, by re-embedding with the
 * same Voyage path the app uses) for the two RAG-adjacent models that still
 * carry both columns: KnowledgeChunk and AgentMemory.
 *
 * Why: the legacy Json column's DROP migration is deliberately NOT shipped —
 * dropping before a prod backfill would lose data for any row whose
 * `embeddingVec` never got populated (rows written before WS-R5, or written
 * while embeddings were unconfigured). This script is that backfill; once it
 * reports zero remaining NULLs in prod, the DROP migration is safe to ship.
 *
 * Strategy per row (cheapest first):
 *   1. `embeddingVec` already set        -> excluded by the query, never seen.
 *   2. legacy `embedding` is a valid 1024-dim number[] -> CONVERT (cast in SQL,
 *      no provider call, no cost).
 *   3. otherwise, if there is text to embed -> RE-EMBED via embedTexts (the
 *      same helper + model + dimension the app uses — src/lib/rag/embeddings.ts).
 *   4. no legacy value and no text         -> SKIP (nothing to do).
 *
 * Resumable: rows are selected with `"embeddingVec" IS NULL`, so a filled row
 * simply stops matching on the next run — safe to re-run, safe to interrupt.
 * Paginates by id (keyset, not OFFSET) so progress is stable even while rows
 * are being filled in underneath it.
 *
 * Cross-tenant by construction (like scripts/rotate-encryption-key.ts): this
 * is a system-wide maintenance sweep over every workspace, so it uses
 * `systemPrisma` directly rather than `tenantTransaction`. `embeddingVec` is a
 * Prisma `Unsupported("vector(1024)")` column, so every read/write against it
 * is raw SQL, same as src/lib/memory/agent-memory.ts and
 * src/lib/knowledge/ingest.ts — including their `SET LOCAL search_path`
 * (Supabase installs the `vector` type in the `extensions` schema).
 *
 * Usage:
 *   npx tsx scripts/reembed-backfill.ts --dry-run
 *   npx tsx scripts/reembed-backfill.ts
 *   npx tsx scripts/reembed-backfill.ts --limit 5000 --batch-size 200
 */

import { Prisma } from '@prisma/client'
import { systemPrisma } from '../src/lib/prisma'
import { embedTexts, embeddingsConfigured, toSqlVector, EMBEDDING_DIM } from '../src/lib/rag/embeddings'
import { computeCostUsd } from '../src/lib/usage/pricing'

const DRY_RUN = process.argv.includes('--dry-run')
const DEFAULT_BATCH_SIZE = 100

function argNumber(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag)
  if (i === -1) return fallback
  const value = Number(process.argv[i + 1])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

const BATCH_SIZE = argNumber('--batch-size', DEFAULT_BATCH_SIZE)
const LIMIT = argNumber('--limit', Infinity)

// ---------------------------------------------------------------------------
// Pure decision logic — no DB, no network. Exercised directly by
// scripts/reembed-backfill.test.ts without a live DB or provider.
// ---------------------------------------------------------------------------

export type RowAction = 'convert' | 'reembed' | 'skip'

/** A legacy `embedding Json?` value is usable iff it's a number[] of exactly `dim` finite numbers. */
export function isValidLegacyVector(value: unknown, dim: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === dim &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  )
}

export interface BackfillRow {
  id: string
  /** Text to send to the embedding provider if a re-embed is needed. */
  text: string
  /** The legacy Json column's current value (already JSON-parsed). */
  legacyEmbedding: unknown
}

/** Decide what one row needs, preferring a free legacy conversion over a paid re-embed. */
export function decideAction(row: BackfillRow, dim: number = EMBEDDING_DIM): RowAction {
  if (isValidLegacyVector(row.legacyEmbedding, dim)) return 'convert'
  if (row.text.trim().length > 0) return 'reembed'
  return 'skip'
}

/** Split ids into stable, order-preserving batches of at most `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk size must be positive')
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Rough token estimate for a cost preview (~4 chars/token, matches common heuristics elsewhere in this codebase's ops tooling). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// ---------------------------------------------------------------------------
// Model-specific plumbing
// ---------------------------------------------------------------------------

interface ModelAdapter {
  label: string
  table: string
  /** Fetch the next page of rows with NULL embeddingVec, keyset-paginated by id. */
  fetchBatch(cursor: string | null, size: number): Promise<BackfillRow[]>
  /** Batch-write embeddingVec for the given (id, vector) pairs. */
  writeBatch(pairs: Array<{ id: string; vector: number[] }>): Promise<void>
}

async function withSearchPath<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return systemPrisma.$transaction(async (tx) => {
    // Supabase installs the `vector` type/extension in `extensions`, not
    // `public` — the `::vector(1024)` cast below fails to resolve without
    // this, same as every other raw-SQL vector write in this codebase.
    await tx.$executeRawUnsafe('SET LOCAL search_path = public, extensions')
    return fn(tx)
  })
}

const knowledgeChunkAdapter: ModelAdapter = {
  label: 'knowledge_chunks',
  table: 'knowledge_chunks',
  async fetchBatch(cursor, size) {
    const rows = await systemPrisma.$queryRaw<Array<{ id: string; content: string; embedding: unknown }>>`
      SELECT "id", "content", "embedding"
      FROM "knowledge_chunks"
      WHERE "embeddingVec" IS NULL
        AND (${cursor}::text IS NULL OR "id" > ${cursor})
      ORDER BY "id" ASC
      LIMIT ${size}
    `
    return rows.map((r) => ({ id: r.id, text: r.content ?? '', legacyEmbedding: r.embedding }))
  },
  async writeBatch(pairs) {
    if (!pairs.length) return
    const values = pairs.map((p) => Prisma.sql`(${p.id}::text, ${toSqlVector(p.vector)}::vector(1024))`)
    await withSearchPath((tx) => tx.$executeRaw`
      UPDATE "knowledge_chunks" AS c
      SET "embeddingVec" = v.vec
      FROM (VALUES ${Prisma.join(values)}) AS v(id, vec)
      WHERE c."id" = v.id
    `)
  },
}

const agentMemoryAdapter: ModelAdapter = {
  label: 'agent_memories',
  table: 'agent_memories',
  async fetchBatch(cursor, size) {
    const rows = await systemPrisma.$queryRaw<
      Array<{ id: string; kind: string; title: string; content: string; question: string | null; embedding: unknown }>
    >`
      SELECT "id", "kind", "title", "content", "question", "embedding"
      FROM "agent_memories"
      WHERE "embeddingVec" IS NULL
        AND (${cursor}::text IS NULL OR "id" > ${cursor})
      ORDER BY "id" ASC
      LIMIT ${size}
    `
    return rows.map((r) => ({
      id: r.id,
      // Mirrors saveAgentMemory's embedText convention exactly (src/lib/memory/agent-memory.ts).
      text: r.kind === 'user_answer' ? r.question ?? r.content ?? '' : `${r.title}\n${r.content}`,
      legacyEmbedding: r.embedding,
    }))
  },
  async writeBatch(pairs) {
    if (!pairs.length) return
    const values = pairs.map((p) => Prisma.sql`(${p.id}::text, ${toSqlVector(p.vector)}::vector(1024))`)
    await withSearchPath((tx) => tx.$executeRaw`
      UPDATE "agent_memories" AS m
      SET "embeddingVec" = v.vec
      FROM (VALUES ${Prisma.join(values)}) AS v(id, vec)
      WHERE m."id" = v.id
    `)
  },
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

interface Tally {
  scanned: number
  convertedFromLegacy: number
  reembedded: number
  skipped: number
  failed: number
}

function newTally(): Tally {
  return { scanned: 0, convertedFromLegacy: 0, reembedded: 0, skipped: 0, failed: 0 }
}

const failures: string[] = []
let remainingBudget = LIMIT
let estimatedReembedTokens = 0

async function processModel(adapter: ModelAdapter): Promise<Tally> {
  const tally = newTally()
  let cursor: string | null = null

  while (remainingBudget > 0) {
    const size = Math.min(BATCH_SIZE, remainingBudget)
    const rows = await adapter.fetchBatch(cursor, size)
    if (rows.length === 0) break
    cursor = rows[rows.length - 1].id
    remainingBudget -= rows.length
    tally.scanned += rows.length

    // Pending writes are tagged with which counter they earn — only booked
    // into `tally` once the write actually succeeds, so a write failure can't
    // double-count a row as both succeeded and failed.
    const toWrite: Array<{ id: string; vector: number[]; source: 'convert' | 'reembed' }> = []
    const toReembed: BackfillRow[] = []

    for (const row of rows) {
      const action = decideAction(row)
      if (action === 'skip') {
        tally.skipped += 1
        continue
      }
      if (action === 'convert') {
        toWrite.push({ id: row.id, vector: row.legacyEmbedding as number[], source: 'convert' })
        continue
      }
      toReembed.push(row)
    }

    if (toReembed.length) {
      if (DRY_RUN) {
        for (const row of toReembed) estimatedReembedTokens += estimateTokens(row.text)
        tally.reembedded += toReembed.length
      } else if (!embeddingsConfigured()) {
        for (const row of toReembed) failures.push(`${adapter.label} ${row.id}: VOYAGE_API_KEY is not configured, cannot re-embed`)
        tally.failed += toReembed.length
      } else {
        try {
          const vectors = await embedTexts(
            toReembed.map((r) => r.text.slice(0, 8000)),
            { inputType: 'document' },
          )
          for (let i = 0; i < toReembed.length; i++) {
            const vector = vectors[i] ?? []
            if (vector.length === EMBEDDING_DIM) {
              toWrite.push({ id: toReembed[i].id, vector, source: 'reembed' })
            } else {
              failures.push(`${adapter.label} ${toReembed[i].id}: embed returned ${vector.length}-dim vector, expected ${EMBEDDING_DIM}`)
              tally.failed += 1
            }
          }
        } catch (error) {
          // Per-row-batch failure — do not abort the run; every row in this
          // batch is reported and the sweep continues with the next batch.
          const message = error instanceof Error ? error.message : String(error)
          for (const row of toReembed) failures.push(`${adapter.label} ${row.id}: ${message}`)
          tally.failed += toReembed.length
        }
      }
    }

    if (!DRY_RUN && toWrite.length) {
      try {
        await adapter.writeBatch(toWrite.map(({ id, vector }) => ({ id, vector })))
        for (const w of toWrite) {
          if (w.source === 'convert') tally.convertedFromLegacy += 1
          else tally.reembedded += 1
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        for (const w of toWrite) failures.push(`${adapter.label} ${w.id}: write failed — ${message}`)
        tally.failed += toWrite.length
      }
    } else if (DRY_RUN) {
      // Dry run books convert counts without writing (reembed counts were
      // already booked above from the estimate loop).
      for (const w of toWrite) if (w.source === 'convert') tally.convertedFromLegacy += 1
    }

    console.log(
      `[${adapter.label}] batch done — scanned ${tally.scanned}, converted ${tally.convertedFromLegacy}, ` +
        `re-embedded ${tally.reembedded}, skipped ${tally.skipped}, failed ${tally.failed} (cursor ${cursor})`,
    )

    if (remainingBudget <= 0) break
  }

  return tally
}

async function main() {
  console.log(`${DRY_RUN ? 'DRY RUN — ' : ''}reembed-backfill starting (batch-size ${BATCH_SIZE}, limit ${LIMIT === Infinity ? 'none' : LIMIT})`)
  if (!DRY_RUN && !embeddingsConfigured()) {
    console.warn('VOYAGE_API_KEY is not configured — legacy-convertible rows will still be filled, but re-embeds will all fail.')
  }

  const results: Array<[string, Tally]> = []
  results.push(['knowledge_chunks', await processModel(knowledgeChunkAdapter)])
  results.push(['agent_memories', await processModel(agentMemoryAdapter)])

  const total = results.reduce<Tally>(
    (sum, [, t]) => ({
      scanned: sum.scanned + t.scanned,
      convertedFromLegacy: sum.convertedFromLegacy + t.convertedFromLegacy,
      reembedded: sum.reembedded + t.reembedded,
      skipped: sum.skipped + t.skipped,
      failed: sum.failed + t.failed,
    }),
    newTally(),
  )

  console.log('\nSummary:')
  for (const [label, t] of results) {
    console.log(
      `  ${label.padEnd(18)} scanned ${t.scanned}  converted ${t.convertedFromLegacy}  re-embedded ${t.reembedded}  skipped ${t.skipped}  failed ${t.failed}`,
    )
  }
  console.log(
    `  ${'TOTAL'.padEnd(18)} scanned ${total.scanned}  converted ${total.convertedFromLegacy}  re-embedded ${total.reembedded}  ` +
      `skipped ${total.skipped}  failed ${total.failed}`,
  )

  if (DRY_RUN) {
    const { costUsd } = computeCostUsd('voyage', 'voyage-3', {
      inputTokens: estimatedReembedTokens,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
    })
    console.log(
      `\nEstimated cost to re-embed ${total.reembedded} row(s): ~${estimatedReembedTokens.toLocaleString()} tokens, ~$${costUsd.toFixed(4)} ` +
        `(voyage-3, rough ~4 chars/token estimate — actual cost may differ). Nothing was written.`,
    )
  }

  if (failures.length) {
    console.error('\nFailures:')
    for (const f of failures) console.error(`  ${f}`)
    console.error(`\n${failures.length} row(s) failed. Re-run this script to retry them (already-populated rows are skipped automatically).`)
    process.exit(1)
  }
}

// Only run the driver when executed directly (`tsx scripts/reembed-backfill.ts`),
// not when imported — scripts/reembed-backfill.test.ts imports the pure
// decision/batching functions above without a live DB or provider.
const isMainModule = import.meta.url === `file://${process.argv[1]}`
if (isMainModule) {
  main()
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
    .finally(() => systemPrisma.$disconnect())
}

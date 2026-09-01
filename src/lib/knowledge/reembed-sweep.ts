/**
 * Knowledge-chunk re-embed sweep.
 *
 * A chunk with `embeddingVec IS NULL` is invisible to the vector retrieval
 * path. Ingestion degrades to that state rather than failing an upload when
 * the embedding provider is unavailable, so something has to come back and
 * finish the job — this is that something, run at cron cadence.
 *
 * One invocation is exactly one bounded pass. There is no internal retry loop:
 * a chunk that fails stays NULL and is picked up on the next tick, which makes
 * the sweep idempotent and safe against a permanently failing row.
 *
 * systemPrisma: cross-org maintenance by design (cron, not a request context),
 * matching src/lib/activity/indexer-sweep.ts and scripts/reembed-backfill.ts.
 */

import { Prisma } from '@prisma/client'
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { embedTexts, embeddingsConfigured, toSqlVector, EMBEDDING_DIM } from '@/lib/rag/embeddings'
import { decideAction, isValidLegacyVector, type BackfillRow } from '@/lib/rag/reembed-decision'
import { deriveIndexState } from './index-state'

export const REEMBED_SWEEP_BATCH_SIZE = 100
/** Documents inspected per tick. Bounds the per-org raw queries below. */
export const REEMBED_SWEEP_DOCUMENT_BATCH = 25

export interface ReembedSweepResult {
  scanned: number
  converted: number
  reembedded: number
  skipped: number
  failed: number
  /** True when the pass did nothing because no embedding provider is configured. */
  skippedNoProvider: boolean
}

type SweepRow = BackfillRow & { documentId: string }

export async function runReembedSweep(
  options: { fetchImpl?: typeof fetch } = {},
): Promise<ReembedSweepResult> {
  const result: ReembedSweepResult = {
    scanned: 0, converted: 0, reembedded: 0, skipped: 0, failed: 0, skippedNoProvider: false,
  }
  if (!embeddingsConfigured()) return { ...result, skippedNoProvider: true }

  // Discovery goes through `indexState` rather than a cross-tenant scan of
  // `embeddingVec IS NULL`. That column is Prisma-visible, which lets every
  // raw statement below carry an `organizationId` filter — knowledge_chunks is
  // a tenant table, and an unscoped write across it is precisely the mistake
  // the raw-SQL tenant guard exists to make impossible.
  //
  // systemPrisma: cross-org maintenance by design (cron, not a request
  // context), matching src/lib/activity/indexer-sweep.ts.
  const documents = await systemPrisma.knowledgeDocument.findMany({
    where: { indexState: { in: ['unindexed', 'partial', 'pending'] } },
    orderBy: { updatedAt: 'asc' },
    take: REEMBED_SWEEP_DOCUMENT_BATCH,
    select: { id: true, organizationId: true },
  })
  if (documents.length === 0) return result

  const byOrg = new Map<string, string[]>()
  for (const document of documents) {
    const list = byOrg.get(document.organizationId) ?? []
    list.push(document.id)
    byOrg.set(document.organizationId, list)
  }

  for (const [organizationId, documentIds] of byOrg) {
    const rows = await systemPrisma.$queryRaw<
      Array<{ id: string; documentId: string; content: string; embedding: unknown }>
    >`
      SELECT "id", "documentId", "content", "embedding"
        FROM "knowledge_chunks"
       WHERE "organizationId" = ${organizationId}::uuid
         AND "documentId" IN (${Prisma.join(documentIds)})
         AND "embeddingVec" IS NULL
       ORDER BY "id" ASC
       LIMIT ${REEMBED_SWEEP_BATCH_SIZE}
    `
    result.scanned += rows.length

    const candidates: SweepRow[] = rows.map((row) => ({
      id: row.id,
      documentId: row.documentId,
      text: row.content ?? '',
      legacyEmbedding: row.embedding,
    }))

    const toWrite: Array<{ id: string; vector: number[] }> = []
    const toReembed: SweepRow[] = []
    for (const row of candidates) {
      const action = decideAction(row)
      if (action === 'convert' && isValidLegacyVector(row.legacyEmbedding, EMBEDDING_DIM)) {
        toWrite.push({ id: row.id, vector: row.legacyEmbedding })
        result.converted += 1
      } else if (action === 'reembed') {
        toReembed.push(row)
      } else {
        result.skipped += 1
      }
    }

    if (toReembed.length) {
      try {
        const vectors = await embedTexts(
          toReembed.map((row) => row.text),
          { inputType: 'document', ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) },
        )
        for (let i = 0; i < toReembed.length; i += 1) {
          const vector = vectors[i]
          if (!vector || vector.length !== EMBEDDING_DIM) {
            result.failed += 1
            continue
          }
          toWrite.push({ id: toReembed[i].id, vector })
          result.reembedded += 1
        }
      } catch (error) {
        result.failed += toReembed.length
        apiLogger.warn('knowledge/reembed-sweep: embed failed, rows stay NULL for the next tick', {
          organizationId,
          count: toReembed.length,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    if (toWrite.length) {
      const values = toWrite.map((pair) => Prisma.sql`(${pair.id}::text, ${toSqlVector(pair.vector)}::vector(1024))`)
      await systemPrisma.$transaction(async (tx) => {
        // Supabase installs the `vector` type in `extensions`, so the cast
        // below does not resolve on a default search_path.
        await tx.$executeRawUnsafe('SET LOCAL search_path = public, extensions')
        await tx.$executeRaw`
          UPDATE "knowledge_chunks" AS c
             SET "embeddingVec" = v.vec
            FROM (VALUES ${Prisma.join(values)}) AS v(id, vec)
           WHERE c."id" = v.id
             AND c."organizationId" = ${organizationId}::uuid
        `
      })
    }

    await recomputeIndexState(organizationId, documentIds)
  }

  return result
}

/**
 * Re-derive `indexState` for the documents this pass touched. A document that
 * is now fully embedded also stops reporting the failure that got it here — a
 * stale indexError on a healthy document is a lie the UI would repeat.
 */
async function recomputeIndexState(organizationId: string, documentIds: string[]): Promise<void> {
  for (const documentId of documentIds) {
    const [counts] = await systemPrisma.$queryRaw<Array<{ total: bigint; embedded: bigint }>>`
      SELECT COUNT(*) AS total, COUNT("embeddingVec") AS embedded
        FROM "knowledge_chunks"
       WHERE "organizationId" = ${organizationId}::uuid
         AND "documentId" = ${documentId}
    `
    const state = deriveIndexState(Number(counts?.total ?? 0), Number(counts?.embedded ?? 0))
    await systemPrisma.knowledgeDocument.updateMany({
      where: { id: documentId, organizationId },
      data: { indexState: state, ...(state === 'indexed' ? { indexError: null } : {}) },
    })
  }
}

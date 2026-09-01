import { prisma, tenantTransaction } from '@/lib/prisma'
import { embedQuery, embeddingsConfigured, toSqlVector } from '@/lib/rag/embeddings'
import { applyRelevanceFloor } from '@/lib/rag/relevance'

export type KnowledgeHit = {
  content: string
  filename: string
  score: number
  documentId?: string
  /**
   * Which retrieval path produced this hit. Keyword hits come from documents
   * whose chunks are not fully embedded — honest about a degraded match.
   */
  matchedBy?: 'vector' | 'keyword'
}

/**
 * Minimum query-term overlap for a keyword hit to be worth showing. Below
 * this, a "match" is one incidental word and is noise next to a vector hit.
 */
export const KEYWORD_ADMISSION_SCORE = 0.5

/**
 * Combine the two retrieval paths without pretending their scores are
 * comparable — cosine similarity and term overlap are different scales, so
 * they are never sorted together. Vector hits fill the result set; keyword
 * hits only fill what is left, and only when they clear the admission score.
 */
export function mergeHits(vectorHits: KnowledgeHit[], keywordHits: KnowledgeHit[], k: number): KnowledgeHit[] {
  const out = vectorHits.slice(0, k)
  if (out.length >= k) return out
  const seen = new Set(out.map((hit) => `${hit.documentId ?? ''}:${hit.content}`))
  for (const hit of keywordHits) {
    if (out.length >= k) break
    if (hit.score < KEYWORD_ADMISSION_SCORE) continue
    const key = `${hit.documentId ?? ''}:${hit.content}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(hit)
  }
  return out
}

/** Fallback relevance when embeddings are unavailable: query-term overlap. */
export function keywordScore(query: string, content: string): number {
  const terms = query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []
  if (!terms.length) return 0
  const haystack = content.toLowerCase()
  let hits = 0
  for (const term of new Set(terms)) if (haystack.includes(term)) hits += 1
  return hits / new Set(terms).size
}

/** Render knowledge hits into a compact block for the agent's system prompt. */
export function renderKnowledge(hits: KnowledgeHit[]): string {
  if (!hits.length) return ''
  const body = hits.map((h) => `— From "${h.filename}":\n${h.content}`).join('\n\n')
  return `## Knowledge (from uploaded files)\nUse the following reference material when relevant. Cite the source file when you rely on it.\n\n${body}`
}

/**
 * Retrieve the most relevant knowledge chunks for an agent. Ranks in-database
 * by pgvector cosine distance (HNSW index) over ALL of the org/agent's
 * embedded chunks when embeddings are available, supplemented by a keyword
 * pass over documents that are not fully embedded (which the vector query
 * cannot see), and falling back to keyword overlap entirely when the query
 * itself cannot be embedded. Best-effort: never throws (returns [] on
 * failure).
 */
export async function retrieveKnowledge(params: {
  organizationId: string
  agentId: string
  query: string
  k?: number
  minScore?: number
}): Promise<KnowledgeHit[]> {
  const k = params.k ?? 5
  try {
    let queryVec: number[] | null = null
    if (embeddingsConfigured()) {
      try {
        queryVec = await embedQuery(params.query)
      } catch {
        queryVec = null
      }
    }

    if (queryVec) {
      const vectorLiteral = toSqlVector(queryVec)
      // search_path guard: Supabase installs pgvector into `extensions`, and a
      // client session's default search_path isn't guaranteed to include it.
      // SET LOCAL scopes the widened path to this transaction only, so the
      // `::vector(1024)` cast resolves regardless of the session default.
      const rows = await tenantTransaction(params.organizationId, async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL search_path = public, extensions')
        // HNSW iterative scan: the index returns global-nearest candidates
        // BEFORE our organizationId filter, so without this a small org can
        // under-return (or get zero) once the table is large enough for the
        // planner to pick the index. Relaxed order keeps recall with the filter.
        await tx.$executeRawUnsafe("SET LOCAL hnsw.iterative_scan = 'relaxed_order'")
        return tx.$queryRaw<Array<{ content: string; filename: string; documentId: string; distance: number }>>`
          SELECT c."content" AS content, d."filename" AS filename, d."id" AS "documentId",
                 (c."embeddingVec" <=> ${vectorLiteral}::vector(1024)) AS distance
          FROM "knowledge_chunks" c
          JOIN "knowledge_documents" d ON d."id" = c."documentId"
          WHERE c."organizationId" = ${params.organizationId}::uuid
            AND d."organizationId" = ${params.organizationId}::uuid
            AND (d."agentId" = ${params.agentId} OR d."agentId" IS NULL)
            AND d."isEnabled" = true
            AND d."status" = 'ready'
            AND c."embeddingVec" IS NOT NULL
          ORDER BY distance ASC
          LIMIT ${k}
        `
      })
      const vectorHits = applyRelevanceFloor(
        rows.map((row) => ({
          content: row.content,
          filename: row.filename,
          documentId: row.documentId,
          score: 1 - row.distance,
          matchedBy: 'vector' as const,
        })),
        params.minScore,
      )
      if (vectorHits.length >= k) return vectorHits

      // Supplementary pass. The query above requires `embeddingVec IS NOT
      // NULL`, so a document whose chunks never embedded — a provider outage
      // during ingest, a workspace that predates embeddings — is structurally
      // invisible to it, and the keyword branch below never runs because the
      // QUERY embedded fine. Those documents were unreachable by either path.
      // Score them by term overlap so they degrade instead of disappearing.
      // Bounded scan: this is a fallback, not a second index.
      const unindexedChunks = await prisma.knowledgeChunk.findMany({
        where: {
          organizationId: params.organizationId,
          document: {
            organizationId: params.organizationId,
            OR: [{ agentId: params.agentId }, { agentId: null }],
            isEnabled: true,
            status: 'ready',
            indexState: { not: 'indexed' },
          },
        },
        select: { content: true, document: { select: { id: true, filename: true } } },
        take: 500,
      })
      if (!unindexedChunks.length) return vectorHits
      const keywordHits = unindexedChunks
        .map((chunk) => ({
          content: chunk.content,
          filename: chunk.document.filename,
          documentId: chunk.document.id,
          score: keywordScore(params.query, chunk.content),
          matchedBy: 'keyword' as const,
        }))
        .sort((a, b) => b.score - a.score)
      return mergeHits(vectorHits, keywordHits, k)
    }

    // Keyword fallback: no embeddings configured (or the query embed call
    // failed) — score a bounded scan of the org/agent's chunks by term overlap.
    const chunks = await prisma.knowledgeChunk.findMany({
      where: {
        organizationId: params.organizationId,
        document: {
          organizationId: params.organizationId,
          OR: [{ agentId: params.agentId }, { agentId: null }],
          isEnabled: true,
          status: 'ready',
        },
      },
      select: { content: true, document: { select: { id: true, filename: true } } },
      take: 500,
    })
    if (!chunks.length) return []
    const scored = chunks.map((chunk) => ({
      content: chunk.content,
      filename: chunk.document.filename,
      documentId: chunk.document.id,
      score: keywordScore(params.query, chunk.content),
      matchedBy: 'keyword' as const,
    }))
    scored.sort((a, b) => b.score - a.score)
    return applyRelevanceFloor(scored.filter((s) => s.score > 0).slice(0, k), params.minScore)
  } catch {
    return []
  }
}

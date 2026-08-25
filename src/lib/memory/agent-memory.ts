import { createHash } from 'node:crypto'
import { prisma, systemPrisma, tenantTransaction } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { embedQuery, embeddingsConfigured, cosineSimilarity, toSqlVector } from '@/lib/rag/embeddings'
import { keywordScore } from '@/lib/knowledge/retrieve'
import { applyRelevanceFloor } from '@/lib/rag/relevance'
import type { NodeVisibility } from '@/lib/rag/store'
import type { indexAgentMemory } from '@/lib/rag/indexer'

export const MEMORY_SIMILARITY_THRESHOLD = 0.86
export const KEYWORD_MATCH_THRESHOLD = 0.6
export const MEMORY_INJECTION_LIMIT = 6
export const AGENT_MEMORY_CAP = 500

export type MemoryKind = 'user_answer' | 'learning' | 'suggestion'
export type MemoryHit = { id: string; kind: string; title: string; content: string; question?: string | null; score: number }

function embeddingOf(value: unknown): number[] | null {
  return Array.isArray(value) ? (value as number[]) : null
}

async function tryEmbed(text: string): Promise<number[] | null> {
  if (!embeddingsConfigured()) return null
  try {
    return await embedQuery(text.slice(0, 4000))
  } catch {
    return null
  }
}

/**
 * Persist one agent memory. Suggestions are deduped against open OR dismissed
 * suggestions (>= threshold cosine bumps timesUsed on the survivor instead of
 * inserting). A dismissed match keeps its 'dismissed' status — dismissing a
 * suggestion is durable and must not be undone by a later run re-proposing
 * the same thing. Enforces the per-agent cap by superseding the oldest
 * learnings. Never throws.
 */
/**
 * A stable fingerprint for "this is the same learning".
 *
 * Normalized so trivial differences — casing, run-on whitespace, a trailing
 * period — do not read as a new memory. Deliberately NOT semantic: near-duplicate
 * detection is the embedding path's job, and this one has to work in a
 * deployment with no embeddings configured at all, which is exactly where
 * duplicates used to accumulate forever.
 */
export function memoryFingerprint(title: string, content: string): string {
  const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim()
  return createHash('sha256').update(`${normalize(title)}\u0000${normalize(content)}`).digest('hex')
}

/**
 * Which memories a recall may read.
 *
 * A resource-scoped recall reads that resource's memories AND the agent's
 * general ones — narrowing must not hide what the agent knows in general, or a
 * question about one account would forget everything learned about the job.
 * An unscoped recall reads everything, exactly as it did before.
 */
export function memoryScopeFilter(
  resourceId?: string | null,
): { OR?: Array<{ resourceId: string | null }> } {
  const scoped = resourceId?.trim()
  return scoped ? { OR: [{ resourceId: scoped }, { resourceId: null }] } : {}
}

export async function saveAgentMemory(params: {
  organizationId: string
  agentId: string
  /** What this memory is about — an account, a record. Omit for general knowledge. */
  resourceId?: string | null
  kind: MemoryKind
  title: string
  content: string
  question?: string
  sourceExecutionId?: string
  // Owner + visibility of the graph insight node this memory produces. Callers
  // saving for a PRIVATE agent MUST pass both (owner = agent.userId, visibility
  // = agent.visibility) — the default below is fail-open ('shared') to match the
  // store-wide `visibility ?? 'shared'` convention, so an omission on a private
  // agent silently re-opens the leak this field was added to close.
  ownerUserId?: string | null
  visibility?: NodeVisibility
}, deps: { index?: typeof indexAgentMemory } = {}): Promise<{ id: string; deduped: boolean } | null> {
  try {
    const embedText = params.kind === 'user_answer' ? params.question ?? params.content : `${params.title}\n${params.content}`
    const embedding = await tryEmbed(embedText)

    if (params.kind === 'suggestion' && embedding) {
      // Nearest-neighbor via pgvector: the single closest open/dismissed
      // suggestion, compared against the threshold. SET LOCAL scopes the
      // widened search_path to this transaction only (see retrieveKnowledge
      // for the same Supabase extensions-schema note).
      const vectorLiteral = toSqlVector(embedding)
      const nearest = await tenantTransaction(params.organizationId, async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL search_path = public, extensions')
        // HNSW iterative scan keeps recall once the org filter narrows the
        // index's global-nearest candidates (see knowledge/retrieve.ts).
        await tx.$executeRawUnsafe("SET LOCAL hnsw.iterative_scan = 'relaxed_order'")
        return tx.$queryRaw<Array<{ id: string; distance: number }>>`
          SELECT "id", ("embeddingVec" <=> ${vectorLiteral}::vector(1024)) AS distance
          FROM "agent_memories"
          WHERE "organizationId" = ${params.organizationId}::uuid
            AND "agentId" = ${params.agentId}
            AND "resourceId" IS NOT DISTINCT FROM ${params.resourceId?.trim() || null}
            AND "kind" = 'suggestion'
            AND "status" IN ('open', 'dismissed')
            AND "embeddingVec" IS NOT NULL
          ORDER BY distance ASC
          LIMIT 1
        `
      })
      const match = nearest[0]
      if (match && 1 - match.distance >= MEMORY_SIMILARITY_THRESHOLD) {
        // Do NOT touch status here: a dismissed suggestion must stay dismissed.
        await prisma.agentMemory.update({
          where: { id: match.id, organizationId: params.organizationId },
          data: { timesUsed: { increment: 1 }, lastUsedAt: new Date() },
        })
        return { id: match.id, deduped: true }
      }
    }

    const resourceId = params.resourceId?.trim() || null
    const contentHash = memoryFingerprint(params.title, params.content)

    // An exact repeat is the SAME memory learned again, not a new one. Recorded
    // as a use of the row that already holds it, which is also what makes
    // `timesUsed` mean something in a deployment with no embeddings — the path
    // where duplicates used to accumulate without limit.
    const existing = await prisma.agentMemory.findFirst({
      where: { organizationId: params.organizationId, agentId: params.agentId, resourceId, contentHash },
      select: { id: true },
    })
    if (existing) {
      await prisma.agentMemory.update({
        where: { id: existing.id, organizationId: params.organizationId },
        data: { timesUsed: { increment: 1 }, lastUsedAt: new Date() },
      })
      return { id: existing.id, deduped: true }
    }

    const created = await prisma.agentMemory.create({
      data: {
        organizationId: params.organizationId,
        agentId: params.agentId,
        resourceId,
        contentHash,
        kind: params.kind,
        title: params.title.slice(0, 200),
        content: params.content,
        question: params.question,
        embedding: embedding ?? undefined,
        sourceExecutionId: params.sourceExecutionId,
      },
    })

    if (embedding) {
      const vectorLiteral = toSqlVector(embedding)
      await tenantTransaction(params.organizationId, async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL search_path = public, extensions')
        await tx.$executeRaw`
          UPDATE "agent_memories" SET "embeddingVec" = ${vectorLiteral}::vector(1024)
          WHERE "id" = ${created.id} AND "organizationId" = ${params.organizationId}::uuid
        `
      })
    }

    // Cap: supersede the oldest open learnings beyond the limit.
    const openCount = await prisma.agentMemory.count({
      where: { organizationId: params.organizationId, agentId: params.agentId, status: 'open' },
    })
    if (openCount > AGENT_MEMORY_CAP) {
      const overflow = await prisma.agentMemory.findMany({
        where: { organizationId: params.organizationId, agentId: params.agentId, status: 'open', kind: 'learning' },
        orderBy: { createdAt: 'asc' },
        take: openCount - AGENT_MEMORY_CAP,
        select: { id: true },
      })
      if (overflow.length) {
        await prisma.agentMemory.updateMany({
          where: { id: { in: overflow.map((m) => m.id) }, organizationId: params.organizationId },
          data: { status: 'superseded' },
        })
      }
    }

    const indexArgs = {
      memoryId: created.id,
      organizationId: params.organizationId,
      agentId: params.agentId,
      kind: params.kind,
      title: params.title,
      content: params.content,
      ownerUserId: params.ownerUserId ?? null,
      visibility: params.visibility ?? 'shared',
    }
    if (deps.index) {
      // Injected in tests — awaited so the assertion is deterministic.
      await deps.index(indexArgs).catch(() => undefined)
    } else {
      void import('@/lib/rag/indexer')
        .then((indexer) => indexer.indexAgentMemory(indexArgs))
        .catch(() => undefined)
    }

    return { id: created.id, deduped: false }
  } catch (error) {
    apiLogger.warn('saveAgentMemory failed', { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

/**
 * Top-k open memories for this agent. Ranks in-database by pgvector cosine
 * distance (HNSW index) over ALL of the agent's open memories when
 * embeddings are available, else falls back to keyword overlap over a
 * bounded scan. Never throws.
 */
export async function retrieveAgentMemory(params: {
  organizationId: string
  agentId: string
  /**
   * Narrow to what the agent knows about ONE thing — an account, a record.
   * The resource's memories AND the agent's general ones come back: narrowing
   * must not make the agent forget everything it has learned about the job.
   */
  resourceId?: string | null
  query: string
  k?: number
  minScore?: number
}): Promise<MemoryHit[]> {
  const k = params.k ?? MEMORY_INJECTION_LIMIT
  const resourceId = params.resourceId?.trim() || null
  try {
    let queryVec: number[] | null = null
    if (embeddingsConfigured()) {
      try {
        queryVec = await embedQuery(params.query.slice(0, 2000))
      } catch {
        queryVec = null
      }
    }

    if (queryVec) {
      const vectorLiteral = toSqlVector(queryVec)
      const rows = await tenantTransaction(params.organizationId, async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL search_path = public, extensions')
        // HNSW iterative scan keeps recall once the org filter narrows the
        // index's global-nearest candidates (see knowledge/retrieve.ts).
        await tx.$executeRawUnsafe("SET LOCAL hnsw.iterative_scan = 'relaxed_order'")
        return tx.$queryRaw<Array<{ id: string; kind: string; title: string; content: string; question: string | null; distance: number }>>`
          SELECT "id", "kind", "title", "content", "question",
                 ("embeddingVec" <=> ${vectorLiteral}::vector(1024)) AS distance
          FROM "agent_memories"
          WHERE "organizationId" = ${params.organizationId}::uuid
            AND "agentId" = ${params.agentId}
            AND (${resourceId}::text IS NULL OR "resourceId" IS NULL OR "resourceId" = ${resourceId})
            AND "status" = 'open'
            AND "embeddingVec" IS NOT NULL
          ORDER BY distance ASC
          LIMIT ${k}
        `
      })
      const hits = rows.map((row) => ({ id: row.id, kind: row.kind, title: row.title, content: row.content, question: row.question, score: 1 - row.distance }))
      return applyRelevanceFloor(hits, params.minScore)
    }

    // Keyword fallback: no embeddings configured (or the query embed call
    // failed) — score a bounded scan of the agent's open memories.
    const rows = await prisma.agentMemory.findMany({
      where: {
        organizationId: params.organizationId,
        agentId: params.agentId,
        status: 'open',
        ...memoryScopeFilter(resourceId),
      },
      select: { id: true, kind: true, title: true, content: true, question: true },
      orderBy: { createdAt: 'desc' },
      take: AGENT_MEMORY_CAP,
    })
    if (!rows.length) return []
    const scored = rows.map((row) => {
      const text = `${row.title}\n${row.question ?? ''}\n${row.content}`
      return { id: row.id, kind: row.kind, title: row.title, content: row.content, question: row.question, score: keywordScore(params.query, text) }
    })
    scored.sort((a, b) => b.score - a.score)
    return applyRelevanceFloor(scored.filter((s) => s.score > 0).slice(0, k), params.minScore)
  } catch {
    return []
  }
}

/** Render memory + critique blocks for the system prompt. '' when empty. */
export function renderAgentMemories(hits: MemoryHit[], latestCritique?: string | null): string {
  const parts: string[] = []
  if (hits.length) {
    const body = hits
      .map((h) => {
        if (h.kind === 'user_answer' && h.question) return `— Previously asked: "${h.question}" → the user answered: ${h.content}`
        return `— ${h.title}: ${h.content}`
      })
      .join('\n')
    parts.push(`## What you've learned (from previous runs)\nApply these remembered facts and lessons; do not re-ask questions the user already answered unless something changed.\n\n${body}`)
  }
  if (latestCritique?.trim()) {
    parts.push(`## Notes to self from last run\n${latestCritique.trim()}`)
  }
  return parts.join('\n\n')
}

/** Pure matcher: closest remembered answer for a question, or null. */
export function bestAnswerMatch(
  questionVec: number[] | null,
  question: string,
  candidates: { id: string; question: string | null; content: string; embedding: unknown }[],
): { id: string; content: string; score: number } | null {
  let best: { id: string; content: string; score: number } | null = null
  for (const candidate of candidates) {
    const vec = embeddingOf(candidate.embedding)
    const score =
      questionVec && vec
        ? cosineSimilarity(questionVec, vec)
        : candidate.question
          ? keywordScore(question, candidate.question)
          : 0
    const threshold = questionVec && vec ? MEMORY_SIMILARITY_THRESHOLD : KEYWORD_MATCH_THRESHOLD
    if (score >= threshold && (!best || score > best.score)) {
      best = { id: candidate.id, content: candidate.content, score }
    }
  }
  return best
}

/** Bump usage counters. Best-effort. */
export async function markMemoriesUsed(ids: string[]): Promise<void> {
  if (!ids.length) return
  try {
    // systemPrisma: best-effort usage bump on memory ids drawn from an org-scoped retrieval.
    await systemPrisma.agentMemory.updateMany({
      where: { id: { in: ids } },
      data: { timesUsed: { increment: 1 }, lastUsedAt: new Date() },
    })
  } catch {
    /* best-effort */
  }
}

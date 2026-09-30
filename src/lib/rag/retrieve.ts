/**
 * Graph-RAG retrieval: turn a natural-language query (or a set of seed entities)
 * into a correlated context pack the model can reason over.
 *
 * Two-stage, the essence of graph RAG:
 *   1. Vector search finds the semantically closest nodes across every source
 *      (Sales AI signals, run outputs carrying MCP/integration data, account
 *      facts, agents).
 *   2. Graph expansion walks edges from those hits to gather the connected
 *      neighborhood — so a hit on one deal pulls in its account, sibling
 *      opportunities, the signals that fired, and prior agent runs. This is
 *      what surfaces cross-source correlations a flat vector search misses.
 *
 * Pure orchestration over the store + embedder; both are injected so the
 * ranking/rendering logic is unit-testable without network or a graph DB.
 */

import { embedQuery, type EmbedOptions } from './embeddings'
import { ragEnabled } from './get-store'
import type { GraphNode, GraphRagStore, SearchHit } from './store'
import { applyRelevanceFloor } from './relevance'

export interface RetrieveOptions {
  organizationId: string
  /**
   * The rep this retrieval is for. Scopes results to shared nodes + this rep's
   * own private nodes; pass null to see only shared nodes. Omitting it defaults
   * to null (shared-only) — callers with a user MUST pass it to see private data.
   */
  viewerUserId?: string | null
  /** Free-text query (assistant question, or the agent objective + signal). */
  query: string
  /** Optional known entity node ids to seed expansion from (e.g. the signal's account). */
  seedNodeIds?: string[]
  topK?: number
  hops?: number
  maxNodes?: number
  embed?: (text: string, options?: EmbedOptions) => Promise<number[]>
  /** Drop search hits scoring below this cosine-similarity floor before expansion. */
  minScore?: number
}

export interface RetrievedContext {
  /** Direct semantic hits, most relevant first. */
  hits: Array<{ id: string; type: string; text: string; score: number; props: Record<string, unknown> }>
  /** Connected neighbors reached by graph expansion. */
  related: Array<{ id: string; type: string; text: string; props: Record<string, unknown> }>
}

const truncate = (text: string, max = 500) => (text.length > max ? `${text.slice(0, max)}…` : text)

/**
 * Retrieve correlated context. Returns an empty pack (never throws) when
 * embeddings aren't configured or the store is empty, so callers can always
 * fold the result in unconditionally.
 */
/**
 * How long graph context may hold up the run (or chat) asking for it. It is
 * supplementary — the answer does not depend on it — so past the budget the
 * caller proceeds without it rather than waiting out a slow or unreachable
 * graph store (a dead Neo4j used to cost the first run after each cooldown
 * 20-40 s). The lookup keeps going in the background and does no harm.
 */
export const RAG_BUDGET_MS = Number(process.env.RAG_BUDGET_MS) || 2_500

export async function retrieveContext(
  store: GraphRagStore,
  options: RetrieveOptions,
): Promise<RetrievedContext> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<RetrievedContext>((resolve) => {
    timer = setTimeout(() => resolve({ hits: [], related: [] }), RAG_BUDGET_MS)
  })
  try {
    return await Promise.race([retrieveContextUnbounded(store, options), budget])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function retrieveContextUnbounded(
  store: GraphRagStore,
  options: RetrieveOptions,
): Promise<RetrievedContext> {
  const topK = options.topK ?? 6
  const hops = options.hops ?? 2
  const maxNodes = options.maxNodes ?? 16
  const embed = options.embed ?? embedQuery
  const viewerUserId = options.viewerUserId ?? null

  if (!ragEnabled() && !options.embed) {
    return { hits: [], related: [] }
  }

  let searchHits: SearchHit[] = []
  try {
    const queryVector = await embed(options.query, { inputType: 'query' })
    if (queryVector.length > 0) {
      searchHits = await store.search(options.organizationId, viewerUserId, queryVector, topK)
    }
  } catch {
    // Retrieval is best-effort — a failed embed/search must not break the caller.
    searchHits = []
  }

  // Floor before expansion so weak hits don't seed the neighborhood walk.
  searchHits = applyRelevanceFloor(searchHits, options.minScore)

  const seedIds = [...new Set([...(options.seedNodeIds ?? []), ...searchHits.map((h) => h.node.id)])]
  let related: GraphNode[] = []
  if (seedIds.length > 0) {
    try {
      related = await store.expand(options.organizationId, viewerUserId, seedIds, hops)
    } catch {
      related = []
    }
  }

  const hitIds = new Set(searchHits.map((h) => h.node.id))
  // One entry per node: a node reachable along several paths comes back once
  // per path, and duplicates only crowd real context out of maxNodes.
  const seen = new Set(hitIds)
  const relatedTrimmed = related.filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true))).slice(0, maxNodes)

  return {
    hits: searchHits.map((h) => ({
      id: h.node.id, type: h.node.type, score: Number(h.score.toFixed(4)),
      text: truncate(h.node.text), props: h.node.props,
    })),
    related: relatedTrimmed.map((n) => ({
      id: n.id, type: n.type, text: truncate(n.text), props: n.props,
    })),
  }
}

/** Render a context pack into compact markdown for a system/user prompt. */
export function renderContext(context: RetrievedContext): string {
  if (context.hits.length === 0 && context.related.length === 0) return ''
  const lines: string[] = ['## Correlated context (Sales AI, integrations, prior runs)']
  if (context.hits.length) {
    lines.push('', 'Most relevant:')
    for (const h of context.hits) lines.push(`- [${h.type}] ${h.text}`)
  }
  if (context.related.length) {
    lines.push('', 'Connected to the above:')
    for (const r of context.related) lines.push(`- [${r.type}] ${r.text}`)
  }
  return lines.join('\n')
}

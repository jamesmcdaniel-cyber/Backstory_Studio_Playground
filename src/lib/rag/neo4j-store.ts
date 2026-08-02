/**
 * Neo4j GraphRagStore adapter.
 *
 * Nodes are stored as `(:Entity {id, organizationId, type, text, embedding,
 * props, updatedAt})`; edges as typed relationships. Vector search uses a
 * Neo4j vector index when present, falling back to org-scoped cosine scoring.
 * `expand` is a variable-length undirected traversal.
 *
 * The neo4j-driver import is dynamic so the package is only required when
 * NEO4J_* is configured — the app builds and runs without it.
 */

import { apiLogger } from '@/lib/logger'
import {
  breakerAllows,
  breakerOnFailure,
  breakerOnProbeStart,
  breakerOnSuccess,
  initialBreakerState,
  type BreakerState,
} from './circuit-breaker'
import { cosineSimilarity, EMBEDDING_DIM } from './embeddings'
import { nodeVisibleTo, type GraphEdge, type GraphNode, type GraphRagStore, type NodeType, type NodeVisibility, type SearchHit } from './store'

const VECTOR_INDEX = 'entity_embedding'

/**
 * Ceiling on the no-vector-index fallback scan (see `search`). Sized to stay
 * well inside a serverless function's memory once each node carries a
 * 1024-float embedding, while still covering any realistic org's graph.
 */
const FALLBACK_SCAN_CAP = Number(process.env.NEO4J_FALLBACK_SCAN_CAP) || 5_000

// Bound how long an unreachable Neo4j can stall a caller. Without these the
// driver's routing-discovery retries ran ~30s PER CALL, and an agent step that
// consults RAG several times spent its whole step timeout on a dead dependency
// (observed live). Connect/acquire/retry are each capped, and after
// NEO4J_BREAKER.threshold consecutive failures the breaker refuses calls for
// cooldownMs so subsequent steps fail in microseconds instead of seconds.
const DRIVER_TIMEOUTS = {
  connectionTimeout: 5_000,
  connectionAcquisitionTimeout: 10_000,
  maxTransactionRetryTime: 5_000,
}
const NEO4J_BREAKER = { threshold: 2, cooldownMs: 60_000 }

export function neo4jConfigured(): boolean {
  return Boolean(process.env.NEO4J_URI && process.env.NEO4J_USERNAME && process.env.NEO4J_PASSWORD)
}

/** Health probe: verify Neo4j connectivity. Non-fatal — RAG degrades if down. */
export async function neo4jPing(): Promise<{ configured: boolean; ok: boolean }> {
  if (!neo4jConfigured()) return { configured: false, ok: false }
  try {
    const neo4j = (await import('neo4j-driver')).default
    const driver = neo4j.driver(
      process.env.NEO4J_URI!,
      neo4j.auth.basic(process.env.NEO4J_USERNAME!, process.env.NEO4J_PASSWORD!),
    )
    try {
      await driver.verifyConnectivity()
      return { configured: true, ok: true }
    } finally {
      await driver.close()
    }
  } catch {
    return { configured: true, ok: false }
  }
}

type Driver = {
  executeQuery: (query: string, params?: Record<string, unknown>) => Promise<{ records: Array<{ get: (k: string) => unknown }> }>
  close: () => Promise<void>
}

export class Neo4jGraphStore implements GraphRagStore {
  private driverPromise: Promise<Driver> | null = null
  private breaker: BreakerState = initialBreakerState()

  private async driver(): Promise<Driver> {
    if (!this.driverPromise) {
      this.driverPromise = (async () => {
        const neo4j = (await import('neo4j-driver')).default
        const driver = neo4j.driver(
          process.env.NEO4J_URI!,
          neo4j.auth.basic(process.env.NEO4J_USERNAME!, process.env.NEO4J_PASSWORD!),
          DRIVER_TIMEOUTS,
        ) as unknown as Driver
        await this.ensureIndexes(driver)
        return driver
      })()
    }
    return this.driverPromise
  }

  /**
   * Every public method funnels through here: the breaker refuses calls while
   * open (callers' existing best-effort catch paths absorb the throw, minus
   * the multi-second stall), and each real failure/success updates it. Every
   * caller of this store already treats errors as degraded-RAG, so a fast
   * refusal is behaviourally identical to a slow failure.
   */
  private async guarded<T>(fn: (driver: Driver) => Promise<T>): Promise<T> {
    const gate = breakerAllows(this.breaker, Date.now())
    if (!gate.allowed) throw new Error('Graph store circuit is open (Neo4j recently unreachable) — RAG call skipped.')
    if (gate.probe) this.breaker = breakerOnProbeStart(this.breaker)
    try {
      const result = await fn(await this.driver())
      this.breaker = breakerOnSuccess(this.breaker)
      return result
    } catch (error) {
      this.breaker = breakerOnFailure(this.breaker, Date.now(), NEO4J_BREAKER)
      if (this.breaker.openUntilMs > 0) {
        // A failed driverPromise would otherwise stay poisoned; dropping it lets
        // the next half-open probe rebuild the connection from scratch.
        this.driverPromise = null
        apiLogger.warn('neo4j: circuit opened — RAG calls refused for cooldown', {
          cooldownMs: NEO4J_BREAKER.cooldownMs,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      throw error
    }
  }

  private async ensureIndexes(driver: Driver): Promise<void> {
    await driver.executeQuery(
      'CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (e:Entity) REQUIRE e.id IS UNIQUE',
    ).catch(() => undefined)
    await driver.executeQuery(
      `CREATE VECTOR INDEX ${VECTOR_INDEX} IF NOT EXISTS FOR (e:Entity) ON (e.embedding)
       OPTIONS { indexConfig: { \`vector.dimensions\`: ${EMBEDDING_DIM}, \`vector.similarity_function\`: 'cosine' } }`,
    ).catch(() => undefined)
  }

  async upsertNodes(nodes: GraphNode[]): Promise<void> {
    if (nodes.length === 0) return
    await this.guarded((driver) => driver.executeQuery(
      `UNWIND $rows AS row
       MERGE (e:Entity { id: row.id })
       SET e.organizationId = row.organizationId, e.type = row.type, e.text = row.text,
           e.props = row.props, e.embedding = row.embedding, e.updatedAt = row.updatedAt,
           e.ownerUserId = row.ownerUserId, e.visibility = row.visibility`,
      {
        rows: nodes.map((n) => ({
          id: n.id, organizationId: n.organizationId, type: n.type, text: n.text,
          props: JSON.stringify(n.props ?? {}), embedding: n.embedding, updatedAt: n.updatedAt ?? new Date().toISOString(),
          ownerUserId: n.ownerUserId ?? null, visibility: n.visibility ?? 'shared',
        })),
      },
    ))
  }

  async upsertEdges(edges: GraphEdge[]): Promise<void> {
    if (edges.length === 0) return
    // Relationship type can't be parameterized; it's from our fixed EdgeRelation
    // union (never user input), so interpolation is safe.
    await this.guarded(async (driver) => {
      for (const edge of edges) {
        await driver.executeQuery(
        `MATCH (a:Entity { id: $from }), (b:Entity { id: $to })
         MERGE (a)-[r:${edge.rel.toUpperCase()}]->(b)
         SET r.organizationId = $organizationId`,
          { from: edge.from, to: edge.to, organizationId: edge.organizationId },
        )
      }
    })
  }

  async search(organizationId: string, viewerUserId: string | null, queryEmbedding: number[], k: number): Promise<SearchHit[]> {
    if (queryEmbedding.length === 0) return []
    return this.guarded(async (driver) => {
    // Over-fetch from the vector index, then filter to the org + viewer scope
    // and take k. `coalesce(...,'shared')` makes legacy nodes (no visibility
    // property) read as shared, so no migration is needed.
    const { records } = await driver.executeQuery(
      `CALL db.index.vector.queryNodes($index, $fetch, $q) YIELD node, score
       WHERE node.organizationId = $org
         AND (coalesce(node.visibility, 'shared') <> 'private' OR node.ownerUserId = $viewer)
       RETURN node, score LIMIT $k`,
      { index: VECTOR_INDEX, fetch: Math.max(k * 4, 20), q: queryEmbedding, org: organizationId, viewer: viewerUserId, k },
    ).catch(async () => {
      // No vector index (e.g. Community edition): fall back to scoring in-app.
      //
      // BOUNDED, deliberately. This pulls whole nodes — embeddings included —
      // into this process's memory, so an unbounded MATCH here is an OOM that
      // scales with the biggest org's graph and fires under exactly the
      // conditions you'd least want it to. The cap trades recall for staying
      // up: results become approximate, so say so loudly rather than let a
      // degraded mode look healthy.
      const all = await driver.executeQuery(
        'MATCH (e:Entity { organizationId: $org }) RETURN e AS node LIMIT $scanCap',
        { org: organizationId, scanCap: FALLBACK_SCAN_CAP },
      )
      if (all.records.length >= FALLBACK_SCAN_CAP) {
        apiLogger.warn('neo4j: vector index unavailable and the fallback scan hit its cap — results are approximate', {
          organizationId,
          scanCap: FALLBACK_SCAN_CAP,
        })
      }
      const scored = all.records
        .map((r) => hydrate(r.get('node')))
        .filter((n): n is GraphNode => n !== null && n.embedding.length > 0 && nodeVisibleTo(n, viewerUserId))
        .map((node) => ({ node, score: cosineSimilarity(queryEmbedding, node.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
      return { records: scored.map((s) => ({ get: (key: string) => (key === 'node' ? toRaw(s.node) : s.score) })) }
    })

    return records
      .map((r) => ({ node: hydrate(r.get('node')), score: Number(r.get('score')) || 0 }))
      .filter((h): h is SearchHit => h.node !== null)
    })
  }

  async expand(organizationId: string, viewerUserId: string | null, nodeIds: string[], hops: number): Promise<GraphNode[]> {
    if (nodeIds.length === 0) return []
    // Only return neighbors the viewer may see — a private node owned by another
    // rep is never surfaced, even if reachable by an edge.
    return this.guarded(async (driver) => {
    const { records } = await driver.executeQuery(
      `MATCH (seed:Entity) WHERE seed.id IN $ids
       MATCH (seed)-[*1..${Math.max(1, Math.min(hops, 3))}]-(n:Entity { organizationId: $org })
       WHERE NOT n.id IN $ids
         AND (coalesce(n.visibility, 'shared') <> 'private' OR n.ownerUserId = $viewer)
       RETURN DISTINCT n AS node`,
      { ids: nodeIds, org: organizationId, viewer: viewerUserId },
    )
    return records.map((r) => hydrate(r.get('node'))).filter((n): n is GraphNode => n !== null)
    })
  }

  async deleteNodes(organizationId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await this.guarded((driver) => driver.executeQuery(
      'MATCH (e:Entity) WHERE e.organizationId = $org AND e.id IN $ids DETACH DELETE e',
      { org: organizationId, ids },
    ))
  }

  async deleteByOwner(organizationId: string, ownerUserId: string): Promise<void> {
    await this.guarded((driver) => driver.executeQuery(
      'MATCH (e:Entity) WHERE e.organizationId = $org AND e.ownerUserId = $owner DETACH DELETE e',
      { org: organizationId, owner: ownerUserId },
    ))
  }

  /** Org teardown: remove every node (and their edges) for this org. */
  async clear(organizationId: string): Promise<void> {
    await this.guarded((driver) => driver.executeQuery(
      'MATCH (e:Entity) WHERE e.organizationId = $org DETACH DELETE e',
      { org: organizationId },
    ))
  }
}

function toRaw(node: GraphNode) {
  return { properties: { ...node, props: JSON.stringify(node.props ?? {}) } }
}

/** Convert a driver node record into a GraphNode, tolerating shape differences. */
function hydrate(raw: unknown): GraphNode | null {
  const props = (raw as { properties?: Record<string, unknown> })?.properties ?? (raw as Record<string, unknown>)
  if (!props || typeof props !== 'object') return null
  const p = props as Record<string, unknown>
  if (typeof p.id !== 'string' || typeof p.organizationId !== 'string') return null
  let parsedProps: Record<string, unknown> = {}
  try {
    parsedProps = typeof p.props === 'string' ? JSON.parse(p.props) : (p.props as Record<string, unknown>) ?? {}
  } catch {
    parsedProps = {}
  }
  return {
    id: p.id,
    organizationId: p.organizationId,
    type: (p.type as NodeType) ?? 'insight',
    text: typeof p.text === 'string' ? p.text : '',
    props: parsedProps,
    embedding: Array.isArray(p.embedding) ? (p.embedding as number[]) : [],
    ownerUserId: typeof p.ownerUserId === 'string' ? p.ownerUserId : null,
    visibility: p.visibility === 'private' ? 'private' : ('shared' as NodeVisibility),
    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : undefined,
  }
}

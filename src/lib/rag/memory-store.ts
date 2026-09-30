/**
 * In-memory GraphRagStore.
 *
 * The default store when no external graph DB is configured, and the substrate
 * for tests. Per-process only (not shared across serverless invocations), so in
 * production it's a graceful no-op-ish fallback rather than a durable store —
 * real deployments set NEO4J_* to get persistence. Retrieval semantics match
 * the Neo4j adapter so the contract test can run against both.
 */

import { cosineSimilarity } from './embeddings'
import { nodeVisibleTo, scopedNodeId, type GraphEdge, type GraphNode, type GraphRagStore, type SearchHit } from './store'

export class MemoryGraphStore implements GraphRagStore {
  // Keyed by workspace-scoped id, as the Neo4j store is: the same logical id
  // in two workspaces is two nodes.
  private nodes = new Map<string, GraphNode>()
  private edges: GraphEdge[] = []

  async upsertNodes(nodes: GraphNode[]): Promise<void> {
    for (const node of nodes) this.nodes.set(scopedNodeId(node.organizationId, node.id), node)
  }

  async upsertEdges(edges: GraphEdge[]): Promise<void> {
    for (const edge of edges) {
      const exists = this.edges.some(
        (e) => e.from === edge.from && e.to === edge.to && e.rel === edge.rel && e.organizationId === edge.organizationId,
      )
      if (!exists) this.edges.push(edge)
    }
  }

  async search(organizationId: string, viewerUserId: string | null, queryEmbedding: number[], k: number): Promise<SearchHit[]> {
    const hits: SearchHit[] = []
    for (const node of this.nodes.values()) {
      if (node.organizationId !== organizationId) continue
      if (node.embedding.length === 0) continue
      if (!nodeVisibleTo(node, viewerUserId)) continue
      hits.push({ node, score: cosineSimilarity(queryEmbedding, node.embedding) })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, k)
  }

  async expand(organizationId: string, viewerUserId: string | null, nodeIds: string[], hops: number): Promise<GraphNode[]> {
    const seen = new Set(nodeIds)
    let frontier = new Set(nodeIds)
    for (let hop = 0; hop < hops; hop++) {
      const next = new Set<string>()
      for (const edge of this.edges) {
        if (edge.organizationId !== organizationId) continue
        // Undirected: a run's neighborhood includes the signal that triggered
        // it and vice versa. Only expand from THIS hop's frontier — newly
        // reached nodes are expanded on the next hop, not the same one.
        if (frontier.has(edge.from) && !seen.has(edge.to)) next.add(edge.to)
        if (frontier.has(edge.to) && !seen.has(edge.from)) next.add(edge.from)
      }
      if (next.size === 0) break
      for (const id of next) seen.add(id)
      frontier = next
    }
    const result: GraphNode[] = []
    for (const id of seen) {
      if (nodeIds.includes(id)) continue // return only the newly-reached neighbors
      const node = this.nodes.get(scopedNodeId(organizationId, id))
      // Only return neighbors the viewer may see — a private node owned by
      // another rep is never surfaced, even if reachable by an edge.
      if (node && node.organizationId === organizationId && nodeVisibleTo(node, viewerUserId)) result.push(node)
    }
    return result
  }

  async deleteNodes(organizationId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return
    const idSet = new Set(ids)
    for (const id of ids) {
      const key = scopedNodeId(organizationId, id)
      const node = this.nodes.get(key)
      if (node && node.organizationId === organizationId) this.nodes.delete(key)
    }
    this.edges = this.edges.filter(
      (e) => !(e.organizationId === organizationId && (idSet.has(e.from) || idSet.has(e.to))),
    )
  }

  async deleteByOwner(organizationId: string, ownerUserId: string): Promise<void> {
    const removed = new Set<string>()
    for (const [key, node] of this.nodes) {
      if (node.organizationId === organizationId && node.ownerUserId === ownerUserId) {
        this.nodes.delete(key)
        removed.add(node.id)
      }
    }
    this.edges = this.edges.filter(
      (e) => !(e.organizationId === organizationId && (removed.has(e.from) || removed.has(e.to))),
    )
  }

  async clear(organizationId: string): Promise<void> {
    for (const [id, node] of this.nodes) if (node.organizationId === organizationId) this.nodes.delete(id)
    this.edges = this.edges.filter((e) => e.organizationId !== organizationId)
  }
}

import type { FlowEdge } from '@/lib/flows/graph'

export type EdgeState = 'unresolved' | 'active' | 'dead'
export type NodeRunState = 'pending' | 'running' | 'done' | 'skipped' | 'failed'

/** The node-completion shapes the scheduler resolves edges for. */
/**
 * `branch` may name SEVERAL branches: a switch with "send to all matching
 * outputs" activates every case it matched, not just the first.
 */
export type EdgeResult = 'ok' | 'route' | 'drop' | 'skip' | { branch: string | string[] }

/**
 * Build incoming/outgoing edge indexes over the OUTER DAG — nodes inside a
 * loop/parallel body (`contained`) and any edge touching them are excluded, so
 * the scheduler treats each container as one node.
 */
export function buildAdjacency(
  nodes: { id: string }[],
  edges: FlowEdge[],
  contained: Set<string>,
): { incoming: Map<string, FlowEdge[]>; outgoing: Map<string, FlowEdge[]>; dagNodeIds: string[] } {
  const dagNodeIds = nodes.map((node) => node.id).filter((id) => !contained.has(id))
  const incoming = new Map<string, FlowEdge[]>()
  const outgoing = new Map<string, FlowEdge[]>()
  for (const id of dagNodeIds) {
    incoming.set(id, [])
    outgoing.set(id, [])
  }
  for (const edge of edges) {
    // AI attachment edges configure a node; they do not participate in the
    // executable data DAG or block readiness of the target node.
    if ((edge.connectionType ?? 'main') !== 'main') continue
    if (contained.has(edge.source) || contained.has(edge.target)) continue
    outgoing.get(edge.source)?.push(edge)
    incoming.get(edge.target)?.push(edge)
  }
  return { incoming, outgoing, dagNodeIds }
}

/**
 * The edge-resolution rules (design §"Edge resolution on node completion"):
 * - `ok` / `skip` → activate every non-error out-edge (fan-out), dead the error edge
 * - `{branch}` → activate the matching branch edge, dead the rest
 * - `route` → the error edge if present (dead the normal), else the normal edge (continue-like)
 * - `drop` → dead all out-edges (this sub-path ends)
 */
export function edgeActivationsFor(result: EdgeResult, outEdges: FlowEdge[]): Map<FlowEdge, 'active' | 'dead'> {
  const acts = new Map<FlowEdge, 'active' | 'dead'>()
  if (typeof result === 'object') {
    const taken = new Set(Array.isArray(result.branch) ? result.branch : [result.branch])
    for (const edge of outEdges) acts.set(edge, edge.branch && taken.has(edge.branch) ? 'active' : 'dead')
    return acts
  }
  if (result === 'drop') {
    for (const edge of outEdges) acts.set(edge, 'dead')
    return acts
  }
  if (result === 'route') {
    const errorEdge = outEdges.find((edge) => edge.branch === 'error')
    for (const edge of outEdges) acts.set(edge, errorEdge ? (edge === errorEdge ? 'active' : 'dead') : 'active')
    return acts
  }
  // ok / skip: fan out to every non-error edge, dead the error edge.
  for (const edge of outEdges) acts.set(edge, edge.branch === 'error' ? 'dead' : 'active')
  return acts
}

/**
 * DFS cycle finder over the outer DAG; returns one offending node path (the
 * cycle) or null. Only ids present in `dagNodeIds` are followed, so edges into
 * container-internal nodes never register as cycles.
 */
export function findCycle(dagNodeIds: string[], outgoing: Map<string, FlowEdge[]>): string[] | null {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>(dagNodeIds.map((id) => [id, WHITE]))
  const stack: string[] = []
  const dfs = (id: string): string[] | null => {
    color.set(id, GRAY)
    stack.push(id)
    for (const edge of outgoing.get(id) ?? []) {
      const next = edge.target
      if (!color.has(next)) continue
      if (color.get(next) === GRAY) return [...stack.slice(stack.indexOf(next)), next]
      if (color.get(next) === WHITE) {
        const found = dfs(next)
        if (found) return found
      }
    }
    color.set(id, BLACK)
    stack.pop()
    return null
  }
  for (const id of dagNodeIds) {
    if (color.get(id) === WHITE) {
      const found = dfs(id)
      if (found) return found
    }
  }
  return null
}

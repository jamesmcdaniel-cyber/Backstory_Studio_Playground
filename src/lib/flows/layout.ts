import dagre from 'dagre'
import type { FlowGraph } from '@/lib/flows/graph'

export type NodePosition = { x: number; y: number }

// Compact n8n-style widget footprint used for layout spacing. The rendered node
// measures itself; these are just the sizes dagre reserves so edges route cleanly.
const NODE_WIDTH = 200
const NODE_HEIGHT = 64
// Left-to-right flow (n8n style): rank = column, so `ranksep` is horizontal gap
// between columns and `nodesep` is vertical gap between siblings in a column.
const RANK_SEP = 90
const NODE_SEP = 28

/**
 * Compute a deterministic left-to-right layout for the OUTER DAG. Container
 * bodies (loop/parallel) are NOT laid out here — each container is a single
 * node, its body edited in the drawer — so those ids are excluded, matching the
 * interpreter's and validator's notion of the outer graph.
 *
 * Pure and side-effect-free: returns id → {x,y} (top-left origin). Nodes that
 * already carry a persisted `position` are honored (dagre is only used to place
 * the ones that don't), so a user's manual arrangement survives re-layout.
 *
 * `force` discards persisted positions and lays every node out from scratch —
 * this is the canvas "Tidy up" action, the one case where overwriting a manual
 * arrangement is what the user asked for.
 */
export function layoutGraph(graph: FlowGraph, options?: { force?: boolean }): Map<string, NodePosition> {
  const contained = new Set(
    graph.nodes.flatMap((node) =>
      node.type === 'loop' ? node.data.body : node.type === 'parallel' ? node.data.branches.flat() : [],
    ),
  )
  const outerNodes = graph.nodes.filter((node) => !contained.has(node.id))
  const outerIds = new Set(outerNodes.map((node) => node.id))

  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', ranksep: RANK_SEP, nodesep: NODE_SEP, marginx: 24, marginy: 24 })
  g.setDefaultEdgeLabel(() => ({}))

  for (const node of outerNodes) g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  for (const edge of graph.edges) {
    // Only edges within the outer DAG participate; an edge touching a contained
    // node (there are none today, but guard) is skipped so dagre never sees an
    // unknown node.
    if (outerIds.has(edge.source) && outerIds.has(edge.target)) g.setEdge(edge.source, edge.target)
  }

  dagre.layout(g)

  const positions = new Map<string, NodePosition>()
  for (const node of outerNodes) {
    // A persisted position wins — manual arrangement is preserved across re-layout.
    if (node.position && !options?.force) {
      positions.set(node.id, { x: node.position.x, y: node.position.y })
      continue
    }
    const laidOut = g.node(node.id)
    // dagre centers nodes; React Flow positions from the top-left corner.
    if (laidOut) positions.set(node.id, { x: laidOut.x - NODE_WIDTH / 2, y: laidOut.y - NODE_HEIGHT / 2 })
    else positions.set(node.id, { x: 0, y: 0 })
  }
  return positions
}

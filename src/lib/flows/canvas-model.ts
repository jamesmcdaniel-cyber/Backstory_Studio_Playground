import type { FlowEdge, FlowGraph, FlowNode } from '@/lib/flows/graph'
import { branchOutputsFor, type BranchOutput } from '@/lib/flows/node-presentation'
import type { NodePosition } from '@/lib/flows/layout'

/**
 * The pure translation layer between a FlowGraph and the canvas. Deliberately
 * free of React and of @xyflow/react imports: everything here is data the
 * canvas components render, so the mapping rules stay unit-testable without a
 * DOM. The canvas component owns presentation; this owns meaning.
 */

/** The id used for a node's plain (non-branch) source handle. */
export const OUT_HANDLE = 'out'
/** The id used for every node's single target handle. */
export const IN_HANDLE = 'in'

/** Ids that live inside a loop body / parallel branch. Those are edited as
 *  ordered lists in the drawer, never drawn as free-form canvas nodes. */
export function containedIds(graph: FlowGraph): Set<string> {
  return new Set(
    graph.nodes.flatMap((node) =>
      node.type === 'loop' ? node.data.body : node.type === 'parallel' ? node.data.branches.flat() : [],
    ),
  )
}

/** The nodes the canvas draws: the outer DAG, containers included as single nodes. */
export function outerNodes(graph: FlowGraph): FlowNode[] {
  const contained = containedIds(graph)
  return graph.nodes.filter((node) => !contained.has(node.id))
}

/** The edges the canvas draws: both endpoints in the outer DAG. */
export function outerEdges(graph: FlowGraph): FlowEdge[] {
  const contained = containedIds(graph)
  return graph.edges.filter((edge) => !contained.has(edge.source) && !contained.has(edge.target))
}

/** A source handle rendered on a node's right edge. */
export type SourceHandle = BranchOutput & { id: string }

/**
 * The source handles a node exposes. Every plain step has one (`out`);
 * condition/switch expose one per branch; a step routing on failure gains an
 * extra `error` handle; `stop` exposes none (nothing runs after it).
 */
export function sourceHandlesFor(node: FlowNode): SourceHandle[] {
  return branchOutputsFor(node).map((output) => ({ ...output, id: output.branch ?? OUT_HANDLE }))
}

/** Whether a node accepts an incoming edge. Only the trigger does not. */
export function hasTargetHandle(node: FlowNode): boolean {
  return node.type !== 'trigger'
}

/** Which source handle an edge leaves from. */
export function sourceHandleOf(edge: FlowEdge): string {
  return edge.branch ?? OUT_HANDLE
}

/**
 * Whether the Inline chain renderer can show this graph faithfully. It walks a
 * single spine (one plain successor per node) and renders branches as nested
 * columns, so it cannot express fan-out (two plain successors) or fan-in (two
 * incoming edges). A graph that fails this must be shown on Canvas — see
 * `unreachableInlineIds` for what Inline would otherwise hide.
 */
export function isLinearRenderable(graph: FlowGraph): boolean {
  const nodes = outerNodes(graph)
  const edges = outerEdges(graph)
  const plainOut = new Map<string, number>()
  const incoming = new Map<string, number>()
  for (const edge of edges) {
    if (!edge.branch) plainOut.set(edge.source, (plainOut.get(edge.source) ?? 0) + 1)
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1)
  }
  for (const node of nodes) {
    if ((plainOut.get(node.id) ?? 0) > 1) return false
    if ((incoming.get(node.id) ?? 0) > 1) return false
  }
  return unreachableInlineIds(graph).length === 0
}

/**
 * Ids the Inline chain walk never DRAWS. Inline lists these separately so no
 * step is invisible.
 *
 * This mirrors the walk in `flow-canvas.tsx` exactly, including its blind spot:
 * from each step it follows only the FIRST plain successor (a second one is a
 * fan-out the vertical chain cannot express) and descends into every branch
 * head. Graph reachability is deliberately NOT the test — a step the DAG can
 * reach but the chain never renders is precisely what has to be reported.
 *
 * Container bodies are reached through their container, not through edges.
 */
export function unreachableInlineIds(graph: FlowGraph): string[] {
  const contained = containedIds(graph)
  const edges = outerEdges(graph)
  const start = graph.nodes.find((node) => node.id === 'trigger') ?? graph.nodes[0]
  const seen = new Set<string>()
  const queue: string[] = start ? [start.id] : []
  while (queue.length) {
    const id = queue.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    // The single plain successor the chain follows — extra ones are the
    // fan-out it drops on the floor.
    const plain = edges.find((edge) => edge.source === id && !edge.branch)
    if (plain && !seen.has(plain.target)) queue.push(plain.target)
    // Branch heads (condition/switch/error) each get their own rendered column.
    for (const edge of edges) {
      if (edge.source !== id || !edge.branch) continue
      if (!seen.has(edge.target)) queue.push(edge.target)
    }
  }
  return graph.nodes
    .filter((node) => !contained.has(node.id) && !seen.has(node.id))
    .map((node) => node.id)
}

/** What a run did with a connection, for edge styling. */
export type EdgeRunState = 'idle' | 'running' | 'succeeded' | 'failed' | 'dead'

/** Statuses that mean a step is still in flight (or about to be). */
const IN_FLIGHT = new Set(['running', 'queued', 'waiting', 'resumed'])

/**
 * Derive per-edge run state from the per-node statuses the run stream already
 * publishes — no engine change needed. A connection into a skipped step is the
 * dead branch. A connection whose target failed is where the run broke —
 * distinct from the succeeded path so green and red never blur together. A
 * plain edge out of a failed step never carried a value (only the `error`
 * branch is taken on failure), so it goes dead rather than lighting up.
 */
export function edgeRunStates(
  graph: FlowGraph,
  statusByNode: Record<string, string>,
): Map<string, EdgeRunState> {
  const states = new Map<string, EdgeRunState>()
  for (const edge of outerEdges(graph)) {
    states.set(edge.id, edgeRunState(edge, statusByNode[edge.source], statusByNode[edge.target]))
  }
  return states
}

function edgeRunState(edge: FlowEdge, source?: string, target?: string): EdgeRunState {
  if (target === 'skipped') return 'dead'
  if (!source) return 'idle'
  if (edge.branch === 'error') {
    // The error route is taken only when its source failed; while the source
    // is still in flight the route's fate is unknown.
    if (IN_FLIGHT.has(source)) return 'idle'
    if (source !== 'failed') return 'dead'
  } else if (source === 'failed') {
    return 'dead'
  }
  if (!target) return 'idle'
  if (target === 'failed') return 'failed'
  if (IN_FLIGHT.has(target)) return 'running'
  return 'succeeded'
}

/** Layout footprint of a canvas chip. Kept in step with `layout.ts` so drag
 *  placement, collision nudging and dagre all reserve the same box. */
export const NODE_WIDTH = 200
export const NODE_HEIGHT = 64
/** Horizontal gap used when placing a node downstream of another. */
export const NODE_GAP_X = 90
/** Vertical step used when nudging a colliding placement out of the way. */
export const NODE_GAP_Y = 28

function overlaps(a: NodePosition, b: NodePosition): boolean {
  return (
    a.x < b.x + NODE_WIDTH &&
    a.x + NODE_WIDTH > b.x &&
    a.y < b.y + NODE_HEIGHT &&
    a.y + NODE_HEIGHT > b.y
  )
}

/**
 * Nudge `desired` downward until it no longer overlaps any occupied box, so a
 * newly inserted step never lands exactly on top of an existing one. Pure and
 * bounded: gives up after enough tries to clear a full column.
 */
export function freePosition(desired: NodePosition, occupied: NodePosition[]): NodePosition {
  let candidate = { ...desired }
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!occupied.some((box) => overlaps(candidate, box))) return candidate
    candidate = { x: candidate.x, y: candidate.y + NODE_HEIGHT + NODE_GAP_Y }
  }
  return candidate
}

/**
 * Where a step inserted downstream of `sourceId` should sit: one column to the
 * right of its source, nudged clear of anything already there. `positions` is
 * the live layout (persisted positions merged with the computed fallback).
 */
export function placeDownstreamOf(
  sourceId: string,
  positions: Map<string, NodePosition>,
): NodePosition {
  const source = positions.get(sourceId) ?? { x: 0, y: 0 }
  const desired = { x: source.x + NODE_WIDTH + NODE_GAP_X, y: source.y }
  return freePosition(desired, [...positions.values()])
}

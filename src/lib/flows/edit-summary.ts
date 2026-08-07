import type { FlowGraph, FlowNode } from './graph'

/**
 * What a save/publish actually changed, computed server-side at write time and
 * stored alongside the snapshot — so the History panel can say WHAT changed,
 * not just who touched the canvas and when. Label lists are capped (counts stay
 * exact) so a huge paste can't bloat the stored row.
 */
export type GraphChangeSummary = {
  added?: { count: number; labels: string[] }
  removed?: { count: number; labels: string[] }
  changed?: { count: number; labels: string[] }
  /** Steps whose only change was canvas position. */
  moved?: number
  edgesAdded?: number
  edgesRemoved?: number
  edgesChanged?: number
}

/** Plain-english fallbacks when a step has no user-given label. */
const TYPE_LABEL: Record<string, string> = {
  trigger: 'Trigger',
  agent: 'Agent step',
  condition: 'If / else',
  loop: 'For each',
  parallel: 'Parallel branches',
  stop: 'Stop flow',
  tool: 'Connected tool',
  http: 'HTTP request',
  transform: 'Set fields',
  filter: 'Filter',
  switch: 'Switch',
  variable: 'Variable',
  data: 'Data step',
  code: 'Code step',
  humanReview: 'Request information',
  output: 'Output',
  join: 'Join paths',
  ai: 'AI step',
  subflow: 'Run a flow',
  knowledge: 'Search knowledge',
  wait: 'Wait',
  note: 'Note',
}

function nodeLabel(node: FlowNode): string {
  const data = node.data as { label?: unknown; text?: unknown }
  const label =
    typeof data.label === 'string' && data.label.trim()
      ? data.label.trim()
      : node.type === 'note' && typeof data.text === 'string' && data.text.trim()
        ? data.text.trim().split('\n')[0]
        : ''
  return (label || TYPE_LABEL[node.type] || node.type).slice(0, 60)
}

const MAX_LABELS = 6

/** Stored graphs predate schema validation in places — normalize defensively. */
function coerceGraph(graph: unknown): FlowGraph {
  const g = graph as { nodes?: unknown; edges?: unknown } | null
  return {
    nodes: Array.isArray(g?.nodes) ? (g.nodes as FlowGraph['nodes']) : [],
    edges: Array.isArray(g?.edges) ? (g.edges as FlowGraph['edges']) : [],
  }
}

function group(labels: string[]): { count: number; labels: string[] } {
  return { count: labels.length, labels: labels.slice(0, MAX_LABELS) }
}

/** Diff two graph states into a summary; null when nothing changed. */
export function summarizeGraphChange(prevGraph: unknown, nextGraph: unknown): GraphChangeSummary | null {
  const prev = coerceGraph(prevGraph)
  const next = coerceGraph(nextGraph)
  const prevById = new Map(prev.nodes.map((n) => [n.id, n]))
  const nextIds = new Set(next.nodes.map((n) => n.id))
  const added: string[] = []
  const changed: string[] = []
  let moved = 0
  const stripPosition = (n: FlowNode) => JSON.stringify({ ...n, position: undefined })
  for (const node of next.nodes) {
    const before = prevById.get(node.id)
    if (!before) {
      added.push(nodeLabel(node))
      continue
    }
    if (JSON.stringify(before) === JSON.stringify(node)) continue
    if (stripPosition(before) === stripPosition(node)) {
      moved += 1
      continue
    }
    changed.push(nodeLabel(node))
  }
  const removed = prev.nodes.filter((n) => !nextIds.has(n.id)).map(nodeLabel)

  const prevEdges = new Map(prev.edges.map((e) => [e.id, e]))
  const nextEdgeIds = new Set(next.edges.map((e) => e.id))
  let edgesAdded = 0
  let edgesChanged = 0
  for (const edge of next.edges) {
    const before = prevEdges.get(edge.id)
    if (!before) edgesAdded += 1
    else if (JSON.stringify(before) !== JSON.stringify(edge)) edgesChanged += 1
  }
  const edgesRemoved = prev.edges.filter((e) => !nextEdgeIds.has(e.id)).length

  if (!added.length && !removed.length && !changed.length && !moved && !edgesAdded && !edgesRemoved && !edgesChanged) {
    return null
  }
  return {
    ...(added.length ? { added: group(added) } : {}),
    ...(removed.length ? { removed: group(removed) } : {}),
    ...(changed.length ? { changed: group(changed) } : {}),
    ...(moved ? { moved } : {}),
    ...(edgesAdded ? { edgesAdded } : {}),
    ...(edgesRemoved ? { edgesRemoved } : {}),
    ...(edgesChanged ? { edgesChanged } : {}),
  }
}

/** One line of plain english for a summary — the History panel's change text. */
export function changeSummaryText(summary: GraphChangeSummary | null | undefined): string {
  if (!summary) return ''
  const parts: string[] = []
  const describe = (verb: string, g?: { count: number; labels: string[] }) => {
    if (!g?.count) return
    parts.push(g.count <= 2 && g.labels.length ? `${verb} ${g.labels.join(', ')}` : `${verb} ${g.count} steps`)
  }
  describe('added', summary.added)
  describe('removed', summary.removed)
  describe('edited', summary.changed)
  if (summary.moved) parts.push(`moved ${summary.moved} step${summary.moved === 1 ? '' : 's'}`)
  const rewired = (summary.edgesAdded ?? 0) + (summary.edgesRemoved ?? 0) + (summary.edgesChanged ?? 0)
  if (rewired) parts.push(`rewired ${rewired} connection${rewired === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

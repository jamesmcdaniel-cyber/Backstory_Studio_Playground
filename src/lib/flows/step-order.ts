import type { FlowGraph } from '@/lib/flows/graph'

/**
 * The steps of a flow in READING ORDER — the order a user walks them on the
 * canvas, top to bottom, branch by branch.
 *
 * `graph.nodes` cannot be used for this directly. Inserting a step on an edge
 * appends it to the array, so array order drifts from flow order the moment
 * anyone edits mid-flow; and the array also holds loop/parallel body steps,
 * which are edited inside their container's drawer and never opened standalone.
 *
 * So: a depth-first walk from the trigger over the OUTER DAG (the same subset
 * the layout and the interpreter treat as the outer graph), following each
 * node's outgoing edges in declaration order so branches read top-down. Nodes
 * the trigger cannot reach — a disconnected step someone has dropped on the
 * canvas but not wired up yet — are still navigable, appended in array order
 * after the connected ones.
 */
export function stepOrder(graph: FlowGraph): string[] {
  const contained = new Set(
    graph.nodes.flatMap((node) =>
      node.type === 'loop' ? node.data.body : node.type === 'parallel' ? node.data.branches.flat() : [],
    ),
  )
  const outer = graph.nodes.filter((node) => !contained.has(node.id))
  const outerIds = new Set(outer.map((node) => node.id))

  const outgoing = new Map<string, string[]>()
  for (const edge of graph.edges) {
    if (!outerIds.has(edge.source) || !outerIds.has(edge.target)) continue
    const targets = outgoing.get(edge.source)
    if (targets) targets.push(edge.target)
    else outgoing.set(edge.source, [edge.target])
  }

  const order: string[] = []
  const seen = new Set<string>()
  const visit = (id: string) => {
    if (seen.has(id)) return
    seen.add(id)
    order.push(id)
    for (const target of outgoing.get(id) ?? []) visit(target)
  }

  if (outerIds.has('trigger')) visit('trigger')
  for (const node of outer) visit(node.id)
  return order
}

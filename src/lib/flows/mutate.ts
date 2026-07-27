import { flowNodeSchema, type FlowGraph, type FlowNode } from '@/lib/flows/graph'
import { buildAdjacency, findCycle } from '@/lib/flows/dag-scheduler'
import type { NodePosition } from '@/lib/flows/layout'

/** Node types a user can create as a step (everything but the trigger). */
export type StepType = Exclude<FlowNode['type'], 'trigger'>

/** Generate a node id not already used in the graph. */
function newNodeId(graph: FlowGraph, prefix = 'n'): string {
  const ids = new Set(graph.nodes.map((node) => node.id))
  let index = graph.nodes.length + 1
  while (ids.has(`${prefix}${index}`)) index += 1
  return `${prefix}${index}`
}

function edgeId(source: string, target: string, branch?: string): string {
  return `${source}->${target}${branch ? `:${branch}` : ''}`
}

/** Default `data` for a freshly created / retyped node. */
function defaultData(type: FlowNode['type'], extra?: { bodyId?: string; agentId?: string }): FlowNode['data'] {
  switch (type) {
    case 'agent':
      // includeUpstreamContext on by default: a newly-added agent automatically
      // receives the data every earlier step captured, so a chain of API/query
      // steps feeding an agent works without hand-wiring a token per step.
      return { agentId: extra?.agentId ?? '', input: 'Use this flow input:\n{{trigger.input}}', includeUpstreamContext: true }
    case 'condition':
      return { match: 'all', clauses: [{ left: '', op: 'contains', right: '' }] }
    case 'loop':
      return { over: '{{trigger.input}}', concurrency: 3, body: extra?.bodyId ? [extra.bodyId] : [] }
    case 'parallel':
      return { branches: extra?.bodyId ? [[extra.bodyId]] : [] }
    case 'stop':
      return { reason: '' }
    case 'tool':
      return { connectionId: '', toolName: '', args: '{}' }
    case 'http':
      return {
        method: 'GET',
        url: '',
        sendQuery: false,
        sendHeaders: false,
        sendBody: false,
        bodyMode: 'json',
        responseType: 'auto',
        failOnHttpError: true,
        retries: 0,
        body: '',
      }
    case 'transform':
      return { fields: [{ name: '', value: '' }] }
    case 'filter':
      return { match: 'all', clauses: [{ left: '', op: 'contains', right: '' }] }
    case 'switch':
      return { cases: [{ id: 'case1', left: '', op: 'contains', right: '' }] }
    case 'variable':
      return { op: 'initialize', name: '', varType: 'string', value: '' }
    case 'data':
      return { op: 'compose', input: '' }
    case 'code':
      return {
        language: 'javascript',
        mode: 'all',
        input: '{{trigger.input}}',
        code: 'return input;',
        timeoutMs: 5000,
      }
    case 'ai':
      return { aiOp: 'ask', input: '', instructions: '' }
    case 'subflow':
      return { flowId: '' }
    case 'knowledge':
      return { query: '' }
    case 'humanReview':
      return { message: '' }
    case 'wait':
      return { mode: 'duration', amount: '1', unit: 'hours' }
    case 'note':
      return { text: '', color: 'yellow' }
    case 'output':
      return { outputs: [{ name: 'output', value: '', type: 'any' }] }
    case 'join':
      // Pure passthrough merge point — no config.
      return {}
    case 'trigger':
      return { trigger: { type: 'manual' } }
  }
}

function makeNode(graph: FlowGraph, type: StepType, agentId?: string): { node: FlowNode; extraNodes: FlowNode[] } {
  const id = newNodeId(graph)
  // Containers are born with one agent body step so they are runnable.
  if (type === 'loop' || type === 'parallel') {
    const bodyId = `${id}b1`
    const body = {
      id: bodyId,
      type: 'agent',
      data: {
        agentId: agentId ?? '',
        input: type === 'loop' ? 'Process this item:\n{{item}}' : 'Use this flow input:\n{{trigger.input}}',
      },
    } as FlowNode
    return { node: { id, type, data: defaultData(type, { bodyId }) } as FlowNode, extraNodes: [body] }
  }
  return { node: { id, type, data: defaultData(type, { agentId }) } as FlowNode, extraNodes: [] }
}

/** Insert a new step of any type immediately after `afterId`, healing the chain. */
export function insertNodeAfter(graph: FlowGraph, afterId: string, type: StepType, agentId?: string): { graph: FlowGraph; nodeId: string } {
  const { node, extraNodes } = makeNode(graph, type, agentId)
  const edges = [...graph.edges]
  // Reconnect afterId's primary outgoing edge through the new node.
  const idx = edges.findIndex((edge) => edge.source === afterId && !edge.branch)
  if (idx >= 0) {
    const old = edges[idx]
    edges[idx] = { id: edgeId(node.id, old.target), source: node.id, target: old.target }
  }
  edges.push({ id: edgeId(afterId, node.id), source: afterId, target: node.id })
  return { graph: { nodes: [...graph.nodes, node, ...extraNodes], edges }, nodeId: node.id }
}

/** Back-compat helper used by earlier tests: insert an agent step. */
export function insertAgentAfter(graph: FlowGraph, afterId: string, agentId: string): { graph: FlowGraph; nodeId: string } {
  return insertNodeAfter(graph, afterId, 'agent', agentId)
}

/**
 * Append a step to a condition's true/false branch: at the tail of the existing
 * branch chain, or as the branch's first node when the branch is empty.
 */
export function appendToBranch(graph: FlowGraph, conditionId: string, branch: string, type: StepType, agentId?: string): { graph: FlowGraph; nodeId: string } {
  const head = graph.edges.find((edge) => edge.source === conditionId && edge.branch === branch)
  if (!head) {
    const { node, extraNodes } = makeNode(graph, type, agentId)
    return {
      graph: {
        nodes: [...graph.nodes, node, ...extraNodes],
        edges: [...graph.edges, { id: edgeId(conditionId, node.id, branch), source: conditionId, target: node.id, branch }],
      },
      nodeId: node.id,
    }
  }
  // Walk to the branch tail (cycle-guarded), then do a plain insert after it.
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const seen = new Set<string>()
  let tail = head.target
  while (!seen.has(tail)) {
    seen.add(tail)
    const next = graph.edges.find((edge) => edge.source === tail && !edge.branch)
    if (!next || !byId.has(next.target)) break
    tail = next.target
  }
  return insertNodeAfter(graph, tail, type, agentId)
}

/** Replace a node (matched by id) with an updated version. Preserves the
 *  existing canvas position when the update doesn't carry one, so editing a
 *  step's data in the drawer never resets where it sits on the canvas. */
export function updateNode(graph: FlowGraph, updated: FlowNode): FlowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.id !== updated.id) return node
      return updated.position === undefined && node.position !== undefined
        ? ({ ...updated, position: node.position } as FlowNode)
        : updated
    }),
  }
}

/** Change a node's type, resetting its data. Containers get a body agent step. */
export function changeNodeType(graph: FlowGraph, id: string, type: StepType): FlowGraph {
  if (type === 'loop' || type === 'parallel') {
    const bodyId = newNodeId(graph, 'b')
    const bodyNode = {
      id: bodyId,
      type: 'agent',
      data: {
        agentId: '',
        input: type === 'loop' ? 'Process this item:\n{{item}}' : 'Use this flow input:\n{{trigger.input}}',
      },
    } as FlowNode
    const nodes = graph.nodes.map((node) => (node.id === id ? ({ id, type, data: defaultData(type, { bodyId }) } as FlowNode) : node))
    return { ...graph, nodes: [...nodes, bodyNode] }
  }
  return { ...graph, nodes: graph.nodes.map((node) => (node.id === id ? ({ id, type, data: defaultData(type) } as FlowNode) : node)) }
}

/** Append a new typed step to a loop body or a new parallel branch. */
export function addContainerStep(graph: FlowGraph, containerId: string, type: StepType = 'agent', agentId?: string): { graph: FlowGraph; nodeId: string } {
  const container = graph.nodes.find((n) => n.id === containerId)
  const isLoop = container?.type === 'loop'
  const { node, extraNodes } = makeNode(graph, type, agentId)
  const bodyNode =
    node.type === 'agent' && isLoop
      ? ({ ...node, data: { ...node.data, input: 'Process this item:\n{{item}}' } } as FlowNode)
      : node.type === 'code' && isLoop
        ? ({ ...node, data: { ...node.data, input: '{{item}}' } } as FlowNode)
      : node
  const nodes = graph.nodes.map((node) => {
    if (node.id !== containerId) return node
    if (node.type === 'loop') return { ...node, data: { ...node.data, body: [...node.data.body, bodyNode.id] } }
    if (node.type === 'parallel') return { ...node, data: { ...node.data, branches: [...node.data.branches, [bodyNode.id]] } }
    return node
  })
  return { graph: { ...graph, nodes: [...nodes, bodyNode, ...extraNodes] }, nodeId: bodyNode.id }
}

/** Locate the container list holding `id`: which container node, which branch
 *  (for parallel), and the index within that list. Null for main-chain ids. */
function containerPositionOf(graph: FlowGraph, id: string): { containerId: string; branchIndex?: number; index: number } | null {
  for (const node of graph.nodes) {
    if (node.type === 'loop') {
      const index = node.data.body.indexOf(id)
      if (index >= 0) return { containerId: node.id, index }
    }
    if (node.type === 'parallel') {
      for (let branchIndex = 0; branchIndex < node.data.branches.length; branchIndex += 1) {
        const index = node.data.branches[branchIndex].indexOf(id)
        if (index >= 0) return { containerId: node.id, branchIndex, index }
      }
    }
  }
  return null
}

/** Insert `insertedId` into the container list right after `position`. */
function insertIntoContainer(graph: FlowGraph, position: { containerId: string; branchIndex?: number; index: number }, insertedId: string): FlowNode[] {
  return graph.nodes.map((entry) => {
    if (entry.id !== position.containerId) return entry
    if (entry.type === 'loop') {
      const body = [...entry.data.body]
      body.splice(position.index + 1, 0, insertedId)
      return { ...entry, data: { ...entry.data, body } }
    }
    if (entry.type === 'parallel' && position.branchIndex !== undefined) {
      const branches = entry.data.branches.map((branch, i) => {
        if (i !== position.branchIndex) return branch
        const next = [...branch]
        next.splice(position.index + 1, 0, insertedId)
        return next
      })
      return { ...entry, data: { ...entry.data, branches } }
    }
    return entry
  })
}

/** Duplicate a step in place: the copy is inserted right after the original. */
export function duplicateNode(graph: FlowGraph, id: string): { graph: FlowGraph; nodeId: string } {
  const original = graph.nodes.find((node) => node.id === id)
  if (!original || original.type === 'trigger') return { graph, nodeId: id }
  const copyId = newNodeId(graph)
  const copy = { id: copyId, type: original.type, data: JSON.parse(JSON.stringify(original.data)) } as FlowNode
  // Containers duplicate shallowly (fresh empty body) — bodies keep their ids
  // and must not be shared between two containers.
  if (copy.type === 'loop') copy.data = { ...copy.data, body: [] }
  if (copy.type === 'parallel') copy.data = { ...copy.data, branches: [] }
  const position = containerPositionOf(graph, id)
  if (position) {
    const nodes = insertIntoContainer(graph, position, copyId)
    return { graph: { nodes: [...nodes, copy], edges: graph.edges }, nodeId: copyId }
  }
  const edges = [...graph.edges]
  const idx = edges.findIndex((edge) => edge.source === id && !edge.branch)
  if (idx >= 0) {
    const old = edges[idx]
    edges[idx] = { id: edgeId(copyId, old.target), source: copyId, target: old.target }
  }
  edges.push({ id: edgeId(id, copyId), source: id, target: copyId })
  return { graph: { nodes: [...graph.nodes, copy], edges }, nodeId: copyId }
}

/**
 * Delete a node, healing the chain: its predecessor connects to its successor,
 * preserving the incoming edge's branch flag (so deleting the first node of a
 * condition branch keeps the branch wired).
 */
export function deleteNode(graph: FlowGraph, id: string): FlowGraph {
  if (id === 'trigger') return graph
  const incomingEdges = graph.edges.filter((edge) => edge.target === id)
  const outgoingEdges = graph.edges.filter((edge) => edge.source === id && !edge.branch)
  const edges = graph.edges.filter((edge) => edge.source !== id && edge.target !== id)
  // Heal the chain ONLY when the wiring is unambiguous — exactly one incoming
  // and one non-branch outgoing (every linear/branch graph). A fan-in or
  // fan-out node has no single correct reconnection, so just drop its edges
  // rather than guess a wiring (which could cross-connect unrelated paths).
  if (incomingEdges.length === 1 && outgoingEdges.length === 1) {
    const incoming = incomingEdges[0]
    const outgoing = outgoingEdges[0]
    edges.push({ id: edgeId(incoming.source, outgoing.target, incoming.branch), source: incoming.source, target: outgoing.target, ...(incoming.branch ? { branch: incoming.branch } : {}) })
  }
  const nodes = graph.nodes
    .filter((node) => node.id !== id)
    // Purge the id from any loop body / parallel branches that referenced it.
    .map((node) => {
      if (node.type === 'loop') return { ...node, data: { ...node.data, body: node.data.body.filter((b) => b !== id) } }
      if (node.type === 'parallel') return { ...node, data: { ...node.data, branches: node.data.branches.map((br) => br.filter((b) => b !== id)) } }
      return node
    })
  return { nodes, edges }
}

/** Delete several nodes at once (bulk selection), healing the chain per node.
 *  Folds deleteNode so each removal reconnects its neighbors before the next. */
export function deleteNodes(graph: FlowGraph, ids: string[]): FlowGraph {
  return ids.filter((id) => id !== 'trigger').reduce((g, id) => deleteNode(g, id), graph)
}

/** Ids living inside a container node's own subtree (its body/branch steps). */
function containedIdsOf(node: FlowNode): string[] {
  if (node.type === 'loop') return node.data.body
  if (node.type === 'parallel') return node.data.branches.flat()
  return []
}

/** Every node id reachable inside `node`'s own subtree: container body/branch
 *  steps (recursively) plus branch-edge chains hanging off condition/switch
 *  descendants. Used to block dropping a node into itself. */
function subtreeIdsOf(graph: FlowGraph, rootId: string): Set<string> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const out = new Set<string>()
  const queue = [rootId]
  while (queue.length) {
    const id = queue.pop()!
    const node = byId.get(id)
    if (!node) continue
    for (const child of containedIdsOf(node)) {
      if (!out.has(child)) {
        out.add(child)
        queue.push(child)
      }
    }
    // Branch-edge children (condition/switch heads) and their plain chains.
    for (const edge of graph.edges) {
      if (edge.source !== id) continue
      if (id === rootId && !edge.branch) continue // the root's main-chain successor is NOT its subtree
      if (!out.has(edge.target)) {
        out.add(edge.target)
        queue.push(edge.target)
      }
    }
  }
  return out
}

/**
 * Move an existing step so it sits immediately after `afterId`, healing both
 * the old and new positions. Container bodies are NOT movable this way — use
 * moveContainerStep. No-op on any invalid move.
 *
 * Condition/switch nodes anchor their subtrees (they have only branch-tagged
 * outgoing edges, never a plain successor) and cannot be relocated by this
 * operation — moving one would sever the chain and orphan its branches.
 */
export function moveNodeAfter(graph: FlowGraph, nodeId: string, afterId: string): FlowGraph {
  if (nodeId === afterId || nodeId === 'trigger') return graph
  const node = graph.nodes.find((n) => n.id === nodeId)
  const target = graph.nodes.find((n) => n.id === afterId)
  if (!node || !target) return graph
  if (node.type === 'condition' || node.type === 'switch') return graph
  if (subtreeIdsOf(graph, nodeId).has(afterId)) return graph
  // A step referenced by any container's body/branches moves via the array API.
  const contained = new Set(graph.nodes.flatMap(containedIdsOf))
  if (contained.has(nodeId)) return graph

  // 1) Detach: heal the chain around the node (deleteNode's edge logic, node kept).
  const incoming = graph.edges.find((edge) => edge.target === nodeId)
  const outgoing = graph.edges.find((edge) => edge.source === nodeId && !edge.branch)
  // Condition/switch nodes are blocked above, so a moved node never owns branch
  // edges here — no need to re-collect/re-append them.
  const edges = graph.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId)
  if (incoming && outgoing) {
    edges.push({
      id: edgeId(incoming.source, outgoing.target, incoming.branch),
      source: incoming.source,
      target: outgoing.target,
      ...(incoming.branch ? { branch: incoming.branch } : {}),
    })
  }

  // 2) Splice after the target (insertNodeAfter's edge logic, existing node).
  const idx = edges.findIndex((edge) => edge.source === afterId && !edge.branch)
  if (idx >= 0) {
    const old = edges[idx]
    edges[idx] = { id: edgeId(nodeId, old.target), source: nodeId, target: old.target }
  }
  edges.push({ id: edgeId(afterId, nodeId), source: afterId, target: nodeId })
  return { ...graph, edges }
}

/** Reorder a loop body (or one parallel branch) by index. Out-of-range no-ops. */
export function moveContainerStep(graph: FlowGraph, containerId: string, from: number, to: number, branchIndex?: number): FlowGraph {
  const container = graph.nodes.find((n) => n.id === containerId)
  if (!container) return graph
  const reorder = (list: string[]): string[] | null => {
    if (from < 0 || to < 0 || from >= list.length || to >= list.length || from === to) return null
    const next = [...list]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    return next
  }
  if (container.type === 'loop') {
    const next = reorder(container.data.body)
    if (!next) return graph
    return updateNode(graph, { ...container, data: { ...container.data, body: next } })
  }
  if (container.type === 'parallel' && branchIndex !== undefined) {
    const branch = container.data.branches[branchIndex]
    if (!branch) return graph
    const next = reorder(branch)
    if (!next) return graph
    const branches = container.data.branches.map((b, i) => (i === branchIndex ? next : b))
    return updateNode(graph, { ...container, data: { ...container.data, branches } })
  }
  return graph
}

// ── Free-form DAG edge editing (Phase 2) ──────────────────────────────────────

/** Ids that live inside a container body — never valid free-form edge endpoints. */
function containerMemberIds(graph: FlowGraph): Set<string> {
  return new Set(graph.nodes.flatMap(containedIdsOf))
}

/**
 * Connect two existing nodes with a new edge (DAG fan-in/fan-out). Rejected —
 * returns the graph unchanged with `added: false` — for a self-loop, a
 * duplicate of an existing edge, an endpoint that is a container body member or
 * the trigger as a target, or any connection that would introduce a CYCLE (the
 * scheduler requires a DAG). `branch` tags a condition/switch/error edge.
 */
export function addEdge(graph: FlowGraph, source: string, target: string, branch?: string): { graph: FlowGraph; added: boolean } {
  if (source === target || target === 'trigger') return { graph, added: false }
  const ids = new Set(graph.nodes.map((n) => n.id))
  if (!ids.has(source) || !ids.has(target)) return { graph, added: false }
  const contained = containerMemberIds(graph)
  if (contained.has(source) || contained.has(target)) return { graph, added: false }
  const exists = graph.edges.some((e) => e.source === source && e.target === target && (e.branch ?? '') === (branch ?? ''))
  if (exists) return { graph, added: false }
  const edge = { id: edgeId(source, target, branch), source, target, ...(branch ? { branch } : {}) }
  const next: FlowGraph = { ...graph, edges: [...graph.edges, edge] }
  // Reject any connection that would make the outer graph cyclic.
  const { outgoing, dagNodeIds } = buildAdjacency(next.nodes, next.edges, contained)
  if (findCycle(dagNodeIds, outgoing)) return { graph, added: false }
  return { graph: next, added: true }
}

/** Remove an edge by id. */
export function removeEdge(graph: FlowGraph, id: string): FlowGraph {
  return { ...graph, edges: graph.edges.filter((edge) => edge.id !== id) }
}

/** Persist canvas positions from a layout/drag. Nodes absent from the map keep theirs. */
export function setNodePositions(graph: FlowGraph, positions: Map<string, NodePosition>): FlowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const pos = positions.get(node.id)
      return pos ? ({ ...node, position: pos } as FlowNode) : node
    }),
  }
}

/** Validate clipboard content into a paste-safe step (never a trigger; containers emptied). */
export function sanitizeCopiedNode(raw: unknown): FlowNode | null {
  const parsed = flowNodeSchema.safeParse(raw)
  if (!parsed.success || parsed.data.type === 'trigger') return null
  const node = parsed.data
  if (node.type === 'loop') return { ...node, data: { ...node.data, body: [] } }
  if (node.type === 'parallel') return { ...node, data: { ...node.data, branches: [] } }
  return node
}

/** Paste a sanitized copied step immediately after `afterId` with a fresh id. */
export function pasteNodeAfter(graph: FlowGraph, afterId: string, copied: FlowNode): { graph: FlowGraph; nodeId: string } {
  const copyId = newNodeId(graph)
  const copy = { id: copyId, type: copied.type, data: JSON.parse(JSON.stringify(copied.data)) } as FlowNode
  const position = containerPositionOf(graph, afterId)
  if (position) {
    const nodes = insertIntoContainer(graph, position, copyId)
    return { graph: { nodes: [...nodes, copy], edges: graph.edges }, nodeId: copyId }
  }
  const edges = [...graph.edges]
  const idx = edges.findIndex((edge) => edge.source === afterId && !edge.branch)
  if (idx >= 0) {
    const old = edges[idx]
    edges[idx] = { id: edgeId(copyId, old.target), source: copyId, target: old.target }
  }
  edges.push({ id: edgeId(afterId, copyId), source: afterId, target: copyId })
  return { graph: { nodes: [...graph.nodes, copy], edges }, nodeId: copyId }
}

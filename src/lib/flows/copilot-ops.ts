import { z } from 'zod'
import { flowNodeSchema, type FlowGraph, type FlowNode } from '@/lib/flows/graph'
import { deleteNode, insertNodeAfter, moveNodeAfter, updateNode, type StepType } from '@/lib/flows/mutate'

/**
 * The copilot edit-op vocabulary: small, targeted graph edits the flow copilot
 * emits and the builder applies. Every mutation routes through the mutate.ts
 * helpers so copilot edits heal chains exactly like manual editing does.
 */

/** Step types the copilot may add (everything but the trigger). */
const STEP_TYPES = ['agent', 'condition', 'loop', 'parallel', 'stop', 'tool', 'http', 'transform', 'filter', 'switch', 'variable', 'data', 'code', 'humanReview', 'output', 'join', 'ai', 'subflow', 'knowledge'] as const satisfies readonly StepType[]

// Model-emitted payloads: arbitrary objects, extra keys tolerated INSIDE the
// payload (z.record keeps every key). Merging is a shallow spread over the
// node's defaults — arrays/objects replace wholesale.
const looseData = z.record(z.unknown())

// Every op object runs in zod's default STRIP mode: unknown OP-LEVEL keys the
// model invents (e.g. a hallucinated `graph` or `note`) are dropped at parse
// time and never echoed back to the client. Only the declared fields survive;
// the free-form `data`/`trigger` payloads above still accept arbitrary keys.
const addOp = z.object({
  op: z.literal('add'),
  type: z.enum(STEP_TYPES),
  afterId: z.string(),
  agentId: z.string().optional(),
  data: looseData.optional(),
})
const updateOp = z.object({ op: z.literal('update'), id: z.string(), data: looseData })
const deleteOp = z.object({ op: z.literal('delete'), id: z.string() })
const moveOp = z.object({ op: z.literal('move'), id: z.string(), afterId: z.string() })
const setTriggerOp = z.object({ op: z.literal('setTrigger'), trigger: looseData })
// The wire shape accepts ONLY `graphJson` — strip mode also drops a
// model-hallucinated `graph` key, so it can never masquerade as
// server-sanitized. The server parses and sanitizes `graphJson`, then attaches
// the trusted `graph` itself; the engine only ever applies `op.graph` and
// never parses `graphJson`.
const replaceOp = z.object({ op: z.literal('replace'), graphJson: z.string() })

export const copilotOpSchema = z.discriminatedUnion('op', [addOp, updateOp, deleteOp, moveOp, setTriggerOp, replaceOp])

/**
 * Runtime op type: the wire schema's output, widened so the replace member
 * carries the server-attached, sanitized `graph?`. Parsed model output never
 * has `graph` — only the server sets it, post-sanitization.
 */
export type CopilotOp =
  | { op: 'add'; type: StepType; afterId: string; agentId?: string; data?: Record<string, unknown> }
  | { op: 'update'; id: string; data: Record<string, unknown> }
  | { op: 'delete'; id: string }
  | { op: 'move'; id: string; afterId: string }
  | { op: 'setTrigger'; trigger: Record<string, unknown> }
  | { op: 'replace'; graphJson: string; graph?: FlowGraph }

export type ApplyResult = {
  graph: FlowGraph
  applied: number
  skipped: { op: CopilotOp; reason: string }[]
  touchedIds: string[]
}

/** Shallow-merge `data` over a node's data and schema-validate the result. */
function mergeNodeData(node: FlowNode, data: Record<string, unknown>): FlowNode | null {
  // Container reference keys are structural wiring, not step config — a data
  // merge must never repoint them. Scoped by node type: only loop `body` and
  // parallel `branches` hold child-node ids (http `body` is a request payload
  // string and stays mergeable). Containers get dedicated ops later.
  const safe = { ...data }
  if (node.type === 'loop') delete safe.body
  if (node.type === 'parallel') delete safe.branches
  // flowNodeSchema runs in zod strip mode, so unknown data keys are silently
  // dropped: an update containing only unknown keys reports applied while
  // changing nothing.
  const parsed = flowNodeSchema.safeParse({ ...node, data: { ...node.data, ...safe } })
  return parsed.success ? parsed.data : null
}

/**
 * Apply copilot ops sequentially against the evolving graph. Each op either
 * applies fully or is skipped with a reason — a failing op never leaves a
 * half-applied graph behind. When nothing applies, the ORIGINAL graph object
 * is returned untouched (identity-preserving, so callers can cheap-compare).
 */
export function applyCopilotOps(graph: FlowGraph, ops: CopilotOp[]): ApplyResult {
  let current = graph
  let applied = 0
  const skipped: { op: CopilotOp; reason: string }[] = []
  const touchedIds: string[] = []

  const apply = (next: FlowGraph) => {
    current = next
    applied += 1
  }
  const touch = (id: string) => {
    if (!touchedIds.includes(id)) touchedIds.push(id)
  }
  const skip = (op: CopilotOp, reason: string) => skipped.push({ op, reason })

  for (const op of ops) {
    switch (op.op) {
      case 'add': {
        if (!current.nodes.some((node) => node.id === op.afterId)) {
          skip(op, `target node "${op.afterId}" not found`)
          break
        }
        const inserted = insertNodeAfter(current, op.afterId, op.type, op.agentId)
        const node = inserted.graph.nodes.find((n) => n.id === inserted.nodeId)
        if (!node) {
          skip(op, 'insert produced no node')
          break
        }
        const merged = mergeNodeData(node, op.data ?? {})
        if (!merged) {
          // Revert the whole op: `current` was never reassigned, so the
          // pre-insert graph stands and this add leaves no trace.
          skip(op, `merged "${op.type}" node is invalid against the node schema`)
          break
        }
        apply(updateNode(inserted.graph, merged))
        touch(merged.id)
        break
      }
      case 'update': {
        const node = current.nodes.find((n) => n.id === op.id)
        if (!node) {
          skip(op, `node "${op.id}" not found`)
          break
        }
        if (node.type === 'trigger') {
          skip(op, 'the trigger node can only be changed via setTrigger')
          break
        }
        const merged = mergeNodeData(node, op.data)
        if (!merged) {
          skip(op, `updated "${node.type}" node is invalid against the node schema`)
          break
        }
        apply(updateNode(current, merged))
        touch(merged.id)
        break
      }
      case 'delete': {
        if (!current.nodes.some((n) => n.id === op.id)) {
          skip(op, `node "${op.id}" not found`)
          break
        }
        const next = deleteNode(current, op.id)
        if (next === current) {
          skip(op, `node "${op.id}" cannot be deleted`)
          break
        }
        apply(next)
        break
      }
      case 'move': {
        if (!current.nodes.some((n) => n.id === op.id)) {
          skip(op, `node "${op.id}" not found`)
          break
        }
        if (!current.nodes.some((n) => n.id === op.afterId)) {
          skip(op, `target node "${op.afterId}" not found`)
          break
        }
        const next = moveNodeAfter(current, op.id, op.afterId)
        if (next === current) {
          skip(op, `node "${op.id}" cannot be moved after "${op.afterId}"`)
          break
        }
        apply(next)
        touch(op.id)
        break
      }
      case 'setTrigger': {
        const trigger = current.nodes.find((n) => n.type === 'trigger')
        if (!trigger) {
          skip(op, 'trigger node not found')
          break
        }
        const prior = (trigger.data as { trigger?: Record<string, unknown> }).trigger ?? {}
        const merged = mergeNodeData(trigger, { trigger: { ...prior, ...op.trigger } })
        if (!merged) {
          skip(op, 'updated trigger is invalid against the node schema')
          break
        }
        apply(updateNode(current, merged))
        touch(merged.id)
        break
      }
      case 'replace': {
        if (!op.graph) {
          skip(op, 'unsanitized replace: server must attach a sanitized graph')
          break
        }
        apply(op.graph)
        // The whole canvas changed — replace touches no individual node ids.
        break
      }
      default: {
        // Accounting invariant: ops.length === applied + skipped.length even
        // for op kinds this engine doesn't know (e.g. newer callers).
        skip(op, 'unknown op')
        break
      }
    }
  }

  return { graph: current, applied, skipped, touchedIds }
}

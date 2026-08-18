import type { FlowEdge, FlowGraph, FlowNode, VariableType } from '@/lib/flows/graph'
import { defaultStepLabel } from '@/lib/flows/token-text'

/**
 * "Make Subflow" (WS18): turn a self-contained region of the flow into a new
 * flow, and replace it in the parent with a single `subflow` step. Pure
 * planning/rewriting only — creating the child flow (and learning its id) is
 * the caller's job, so extraction is two-phase:
 *
 *   1. `planSubflowExtraction(graph, startId, endId)` → the child graph to
 *      create, what the parent should send, and the range ids.
 *   2. `replaceRangeWithSubflow(graph, plan, childFlowId, name)` → the parent
 *      graph with the range swapped for a wired subflow step.
 *
 * Branching is supported. The region is everything reachable from the start
 * step with the end step treated as a wall, so If/else, Switch and Join steps
 * come along with their branch edges intact — PROVIDED the region is
 * structurally self-contained:
 *   - nothing outside connects INTO the region except at the start step, and
 *   - nothing inside the region is also reachable AFTER the end step (that
 *     would mean a branch opened inside and closed outside), and
 *   - the end step doesn't itself split into branches.
 * Each failure names the step that breaks containment so the user knows what
 * to add to the selection.
 *
 * Variables are flow-wide, so they are classified against the region:
 *   - read inside but not initialized inside → a subflow INPUT: the parent
 *     sends `{{var.x}}`, and the child initializes `x` from its trigger input
 *     before the moved steps run, so every `{{var.x}}` read moves unchanged.
 *   - written inside and read outside → a subflow OUTPUT: the child declares a
 *     named output carrying the final `{{var.x}}`, and the parent writes it
 *     back into `x` in a step placed right after the subflow step.
 *   - used only inside → moves in wholesale, no wiring at all.
 * Both directions reuse the subflow step's existing per-field `inputs` map and
 * the flow's existing named-`output` step — no parallel mechanism.
 *
 * Step-output token safety (refused with a plain-English error otherwise): the
 * region may reference its own steps, `{{trigger.input*}}`, and at most ONE
 * step outside the region. Outside-step references are rewritten to the child's
 * trigger input, and the parent sends that step's output — so the extracted
 * steps see identical data.
 */

export type SubflowOutputVariable = {
  name: string
  /** Whether the parent re-declares the variable (it was initialized inside). */
  op: 'initialize' | 'set'
  varType?: VariableType
}

export type SubflowExtractionPlan = {
  /** Every node moving into the child: the region plus container bodies. */
  rangeIds: string[]
  childGraph: FlowGraph
  /** What the parent's subflow step sends as its free-form input. */
  childInput: string
  /** Per-field inputs the parent sends when variables (or both) are in play. */
  childInputs?: Record<string, string>
  /** Variables the child hands back, written into the parent after the step. */
  outputVariables: SubflowOutputVariable[]
  startId: string
  endId: string
}

const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g
/** Names a subflow input/output field can carry verbatim. */
const SAFE_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Main-chain successor (the only unlabeled outgoing edge's target). */
function nextOf(graph: FlowGraph, id: string): string | null {
  const edge = graph.edges.find((e) => e.source === id && !e.branch)
  return edge ? edge.target : null
}

/** Node ids living inside a container node (loop body / parallel branches). */
function containedIdsOf(node: FlowNode): string[] {
  if (node.type === 'loop') return node.data.body
  if (node.type === 'parallel') return node.data.branches.flat()
  return []
}

function labelOf(node: FlowNode | undefined, fallback: string): string {
  if (!node) return fallback
  const label = 'label' in node.data ? node.data.label : undefined
  return label || defaultStepLabel(node)
}

function collectTokenPaths(value: unknown, paths: string[]): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(TOKEN_RE)) paths.push(match[1])
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectTokenPaths(entry, paths)
    return
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) collectTokenPaths(entry, paths)
  }
}

function rewriteTokens(value: unknown, rewrite: (path: string) => string): unknown {
  if (typeof value === 'string') {
    return value.replace(TOKEN_RE, (_whole, path: string) => `{{${rewrite(path)}}}`)
  }
  if (Array.isArray(value)) return value.map((entry) => rewriteTokens(entry, rewrite))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewriteTokens(entry, rewrite)]))
  }
  return value
}

/** How a set of nodes touches the flow-wide symbol table. */
type VariableUsage = {
  reads: Set<string>
  writes: Set<string>
  initializes: Set<string>
  declaredTypes: Map<string, VariableType>
}

function variableUsage(nodes: FlowNode[]): VariableUsage {
  const usage: VariableUsage = { reads: new Set(), writes: new Set(), initializes: new Set(), declaredTypes: new Map() }
  for (const node of nodes) {
    const paths: string[] = []
    collectTokenPaths(node.data, paths)
    for (const path of paths) {
      const parts = path.split('.')
      if (parts[0] === 'var' && parts[1]) usage.reads.add(parts[1])
    }
    if (node.type !== 'variable') continue
    const name = node.data.name?.trim()
    if (!name) continue
    usage.writes.add(name)
    if (node.data.op === 'initialize') {
      usage.initializes.add(name)
      if (node.data.varType) usage.declaredTypes.set(name, node.data.varType)
    } else if (node.data.op !== 'set') {
      // increment / decrement / append* read the current value before writing.
      usage.reads.add(name)
    }
  }
  return usage
}

const FIELD_TYPE_OF_VARIABLE: Record<VariableType, string> = {
  boolean: 'boolean',
  integer: 'number',
  float: 'number',
  string: 'string',
  object: 'object',
  array: 'array',
}

/** A name not already taken, e.g. `input` → `input2` when `input` is a variable. */
function freeName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  let index = 2
  while (taken.has(`${base}${index}`)) index += 1
  return `${base}${index}`
}

export function planSubflowExtraction(
  graph: FlowGraph,
  startId: string,
  endId: string,
): SubflowExtractionPlan | { error: string } {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const start = byId.get(startId)
  const end = byId.get(endId)
  if (!start || !end) return { error: 'Pick steps that are still on the canvas.' }
  if (start.type === 'trigger' || end.type === 'trigger') return { error: 'The trigger cannot move into a subflow.' }

  const containedAnywhere = new Set(graph.nodes.flatMap(containedIdsOf))
  if (containedAnywhere.has(startId) || containedAnywhere.has(endId)) {
    return { error: 'Steps inside a For each or Parallel container cannot be extracted — extract the whole container instead.' }
  }

  const outgoing = new Map<string, FlowEdge[]>()
  const incoming = new Map<string, FlowEdge[]>()
  for (const edge of graph.edges) {
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, [])
    outgoing.get(edge.source)!.push(edge)
    if (!incoming.has(edge.target)) incoming.set(edge.target, [])
    incoming.get(edge.target)!.push(edge)
  }

  // The region: everything reachable from the start step, following EVERY edge
  // (branch edges included), with the end step as a wall. On a straight run
  // this is exactly the old main-chain walk; with branching it is the whole
  // If/else or Switch fan-out down to the Join the user picked as the end.
  const region = new Set<string>()
  const order: string[] = []
  const queue: string[] = [startId]
  while (queue.length) {
    const id = queue.shift()!
    if (region.has(id) || !byId.has(id)) continue
    region.add(id)
    order.push(id)
    if (id === endId) continue
    for (const edge of outgoing.get(id) ?? []) queue.push(edge.target)
  }
  if (!region.has(endId)) {
    return { error: 'The end step must come after the start step on the same path.' }
  }

  // The end step must be a single exit. A step that fans out into branches
  // can't be the wall — its branches would be orphaned in the parent.
  const endOut = outgoing.get(endId) ?? []
  if (endOut.length > 1 || endOut.some((edge) => edge.branch)) {
    const label = labelOf(end, endId)
    return {
      error: `"${label}" splits into branches, so the selection can't end there — extend it to the step where those branches come back together.`,
    }
  }

  // Containment 1: nothing inside the selection may also be reachable AFTER the
  // end step. When it is, a branch opened inside closes outside.
  const afterEnd = new Set<string>()
  const afterQueue = endOut.map((edge) => edge.target)
  while (afterQueue.length) {
    const id = afterQueue.shift()!
    if (afterEnd.has(id) || !byId.has(id)) continue
    afterEnd.add(id)
    for (const edge of outgoing.get(id) ?? []) afterQueue.push(edge.target)
  }
  const escaping = order.find((id) => id !== endId && afterEnd.has(id))
  if (escaping) {
    const label = labelOf(byId.get(escaping), escaping)
    return {
      error: `This selection isn't self-contained — "${label}" is reached both inside it and after the last selected step. Extend the selection to end at "${label}".`,
    }
  }

  // Containment 2: nothing outside may connect INTO the selection except at the
  // start step — otherwise a branch opened outside closes inside.
  for (const id of order) {
    if (id === startId) continue
    const outsideEdge = (incoming.get(id) ?? []).find((edge) => !region.has(edge.source))
    if (!outsideEdge) continue
    const label = labelOf(byId.get(id), id)
    const sourceLabel = labelOf(byId.get(outsideEdge.source), outsideEdge.source)
    return {
      error: `This selection isn't self-contained — "${label}" also receives a connection from "${sourceLabel}", which is outside it. Start the selection at "${sourceLabel}", or include it.`,
    }
  }

  // The subtree: region + container bodies riding along.
  const rangeIds = new Set(region)
  for (const id of order) {
    const node = byId.get(id)
    if (node) for (const contained of containedIdsOf(node)) rangeIds.add(contained)
  }
  const movedNodes = Array.from(rangeIds).map((id) => byId.get(id)!).filter(Boolean)
  const stayingNodes = graph.nodes.filter((node) => !rangeIds.has(node.id))

  // Token safety: scan every moved node's data for step references leaving the
  // region. Variables are handled separately, below.
  const outsideSteps = new Set<string>()
  for (const node of movedNodes) {
    const paths: string[] = []
    collectTokenPaths(node.data, paths)
    for (const path of paths) {
      const parts = path.split('.')
      if (parts[0] === 'step' && parts[1] && !rangeIds.has(parts[1])) outsideSteps.add(parts[1])
    }
  }
  // {{item}}/{{loop.*}} at the top level would mean we're inside a loop body;
  // top-level region nodes never legally reference them, and in-region
  // containers keep their own item scope — so no extra check needed here.
  if (outsideSteps.size > 1) {
    const labels = Array.from(outsideSteps).map((id) => `"${labelOf(byId.get(id), id)}"`).join(', ')
    return { error: `These steps read from more than one earlier step (${labels}) — a subflow can receive only one input. Combine them first (e.g. with a Compose step).` }
  }

  // Variables: classify every name the region touches into in / out / local.
  const inside = variableUsage(movedNodes)
  const outsideUsage = variableUsage(stayingNodes)
  const inputVariables: string[] = []
  const outputVariables: SubflowOutputVariable[] = []
  const touched = Array.from(new Set([...inside.reads, ...inside.writes])).sort()
  for (const name of touched) {
    const isInput = inside.reads.has(name) && !inside.initializes.has(name)
    const isOutput = inside.writes.has(name) && outsideUsage.reads.has(name)
    if (!isInput && !isOutput) continue // entirely local — it moves in wholesale
    if (!SAFE_VARIABLE_NAME.test(name)) {
      return {
        error: `The variable "${name}" is used on both sides of this selection, but its name can't be carried as a subflow input or output. Rename it using letters, numbers and underscores first.`,
      }
    }
    const varType = inside.declaredTypes.get(name) ?? outsideUsage.declaredTypes.get(name)
    if (isInput) inputVariables.push(name)
    if (isOutput) {
      outputVariables.push({
        name,
        op: inside.initializes.has(name) && !outsideUsage.initializes.has(name) ? 'initialize' : 'set',
        ...(varType ? { varType } : {}),
      })
    }
  }

  // With named variable inputs the child's trigger input becomes an object, so
  // the pass-through value the region used to read as `{{trigger.input}}` needs
  // a field of its own. Pick one that no variable has claimed.
  const passField = inputVariables.length ? freeName('input', new Set(inputVariables)) : null
  const passPath = passField ? ['trigger', 'input', passField] : ['trigger', 'input']

  const outside = Array.from(outsideSteps)[0]
  const rewrite = (path: string): string => {
    const parts = path.split('.')
    if (outside && parts[0] === 'step' && parts[1] === outside && parts[2] === 'output') {
      return [...passPath, ...parts.slice(3)].join('.')
    }
    if (passField && parts[0] === 'trigger' && parts[1] === 'input') {
      return [...passPath, ...parts.slice(2)].join('.')
    }
    return path
  }

  const takenIds = new Set([...rangeIds, 'trigger'])
  const movedRewritten: FlowNode[] = movedNodes.map((node) => ({ ...node, data: rewriteTokens(node.data, rewrite) }) as FlowNode)

  // Inbound variables: initialize each from the child's own trigger input
  // BEFORE the moved steps run, so every `{{var.x}}` inside them still reads
  // the right value and in-region writes still work on a real variable.
  const inputNodes: FlowNode[] = inputVariables.map((name) => {
    const id = freeName(`receive_${name}`, takenIds)
    takenIds.add(id)
    const varType = inside.declaredTypes.get(name) ?? outsideUsage.declaredTypes.get(name) ?? 'string'
    return {
      id,
      type: 'variable',
      data: { op: 'initialize', name, varType, value: `{{trigger.input.${name}}}`, label: `Receive ${name}` },
    } as FlowNode
  })

  // Outbound variables: a named-output step hands the final values back. The
  // region's own result rides along under its own field so the parent's next
  // step still has it.
  const outputNodes: FlowNode[] = []
  if (outputVariables.length) {
    const id = freeName('hand_back', takenIds)
    takenIds.add(id)
    const resultField = freeName('result', new Set(outputVariables.map((variable) => variable.name)))
    outputNodes.push({
      id,
      type: 'output',
      data: {
        label: 'Hand back results',
        outputs: [
          { name: resultField, value: `{{step.${endId}.output}}`, type: 'any' },
          ...outputVariables.map((variable) => ({ name: variable.name, value: `{{var.${variable.name}}}`, type: 'any' as const })),
        ],
      },
    } as FlowNode)
  }

  const inputFields = inputVariables.map((name) => {
    const varType = inside.declaredTypes.get(name) ?? outsideUsage.declaredTypes.get(name)
    return { name, type: varType ? FIELD_TYPE_OF_VARIABLE[varType] : 'any', description: `Value of the variable ${name} when this flow starts.` }
  })
  if (passField) {
    inputFields.unshift({ name: passField, type: 'any', description: 'The data the calling flow passes in.' })
  }

  const triggerNode = {
    id: 'trigger',
    type: 'trigger',
    data: { trigger: inputFields.length ? { type: 'manual', inputFields } : { type: 'manual' } },
  } as FlowNode

  // Head of the child chain: the receive-variable steps, then the region.
  const headIds = [...inputNodes.map((node) => node.id), startId]
  const childEdges: FlowEdge[] = []
  let previous = 'trigger'
  for (const id of headIds) {
    childEdges.push({ id: `${previous}->${id}`, source: previous, target: id })
    previous = id
  }
  // Every edge fully inside the region comes along, branch labels intact.
  childEdges.push(...graph.edges.filter((edge) => rangeIds.has(edge.source) && rangeIds.has(edge.target)))
  for (const node of outputNodes) {
    childEdges.push({ id: `${endId}->${node.id}`, source: endId, target: node.id })
  }

  const childInputs: Record<string, string> = {}
  if (passField) {
    childInputs[passField] = outside ? `{{step.${outside}.output}}` : '{{trigger.input}}'
    for (const name of inputVariables) childInputs[name] = `{{var.${name}}}`
  }

  return {
    rangeIds: Array.from(rangeIds),
    childGraph: { nodes: [triggerNode, ...inputNodes, ...movedRewritten, ...outputNodes], edges: childEdges },
    childInput: outside ? `{{step.${outside}.output}}` : '{{trigger.input}}',
    ...(passField ? { childInputs } : {}),
    outputVariables,
    startId,
    endId,
  }
}

/** Swap the planned range for a subflow step pointing at the created child. */
export function replaceRangeWithSubflow(
  graph: FlowGraph,
  plan: SubflowExtractionPlan,
  childFlowId: string,
  childName: string,
): { graph: FlowGraph; nodeId: string } {
  const range = new Set(plan.rangeIds)
  const ids = new Set(graph.nodes.map((node) => node.id))
  let index = graph.nodes.length + 1
  const freeNodeId = (): string => {
    while (ids.has(`n${index}`)) index += 1
    const id = `n${index}`
    ids.add(id)
    return id
  }
  const nodeId = freeNodeId()

  const inbound = graph.edges.filter((edge) => !range.has(edge.source) && edge.target === plan.startId)
  const outboundNext = nextOf(graph, plan.endId)

  const nodes = graph.nodes.filter((node) => !range.has(node.id))
  const edges: FlowEdge[] = graph.edges.filter((edge) => !range.has(edge.source) && !range.has(edge.target))
  for (const edge of inbound) {
    edges.push({ ...edge, id: `${edge.source}->${nodeId}${edge.branch ? `:${edge.branch}` : ''}`, target: nodeId })
  }

  const subflowNode = {
    id: nodeId,
    type: 'subflow',
    data: {
      flowId: childFlowId,
      input: plan.childInput,
      ...(plan.childInputs ? { inputs: plan.childInputs } : {}),
      label: childName,
    },
  } as FlowNode

  // Variables the child wrote for the rest of the flow are written back right
  // after the subflow step, so downstream `{{var.x}}` reads are unchanged.
  const writeBackNodes: FlowNode[] = plan.outputVariables.map((variable) => ({
    id: freeNodeId(),
    type: 'variable',
    data: {
      op: variable.op,
      name: variable.name,
      ...(variable.varType ? { varType: variable.varType } : {}),
      value: `{{step.${nodeId}.output.${variable.name}}}`,
      label: `Update ${variable.name}`,
    },
  }) as FlowNode)

  let tail = nodeId
  for (const node of writeBackNodes) {
    edges.push({ id: `${tail}->${node.id}`, source: tail, target: node.id })
    tail = node.id
  }
  if (outboundNext && !range.has(outboundNext)) {
    edges.push({ id: `${tail}->${outboundNext}`, source: tail, target: outboundNext })
  }

  return { graph: { nodes: [...nodes, subflowNode, ...writeBackNodes], edges }, nodeId }
}

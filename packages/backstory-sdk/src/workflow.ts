export const NODE_TYPES = [
  'trigger', 'agent', 'condition', 'loop', 'parallel', 'stop', 'tool', 'http',
  'transform', 'filter', 'switch', 'variable', 'data', 'code', 'humanReview',
  'output', 'join', 'ai', 'subflow', 'knowledge', 'wait', 'note',
] as const

export type NodeType = (typeof NODE_TYPES)[number]
export type ConnectionType =
  | 'main'
  | 'ai_languageModel'
  | 'ai_tool'
  | 'ai_memory'
  | 'ai_outputParser'
  | 'ai_embedding'
  | 'ai_document'
  | 'ai_textSplitter'
  | 'ai_vectorStore'
  | 'ai_retriever'

export type WorkflowNode<TData extends Record<string, unknown> = Record<string, unknown>> = {
  id: string
  type: NodeType
  typeVersion: number
  data: TData
  position?: { x: number; y: number }
  disabled?: boolean
}

export type WorkflowEdge = {
  id: string
  source: string
  target: string
  branch?: string
  connectionType?: ConnectionType
  sourceOutput?: number
  targetInput?: number
}

export type WorkflowGraph = {
  schemaVersion: 2
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  pinData?: Record<string, unknown>
}

export type WorkflowIssue = { level: 'error' | 'warning'; code: string; message: string; nodeId?: string }

let sequence = 0
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(++sequence).toString(36)}`

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  return value as Record<string, unknown>
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function validateWorkflow(graph: WorkflowGraph): WorkflowIssue[] {
  const issues: WorkflowIssue[] = []
  const ids = new Set<string>()
  for (const node of graph.nodes) {
    if (!node.id.trim()) issues.push({ level: 'error', code: 'NODE_ID_REQUIRED', message: 'Every node needs an id.' })
    else if (ids.has(node.id)) issues.push({ level: 'error', code: 'DUPLICATE_NODE_ID', message: `Duplicate node id "${node.id}".`, nodeId: node.id })
    ids.add(node.id)
    if (!NODE_TYPES.includes(node.type)) issues.push({ level: 'error', code: 'UNKNOWN_NODE_TYPE', message: `Unknown node type "${node.type}".`, nodeId: node.id })
    if (!Number.isInteger(node.typeVersion) || node.typeVersion < 1) issues.push({ level: 'error', code: 'INVALID_TYPE_VERSION', message: 'typeVersion must be a positive integer.', nodeId: node.id })
  }
  const triggers = graph.nodes.filter((node) => node.type === 'trigger')
  if (triggers.length !== 1) issues.push({ level: 'error', code: 'TRIGGER_COUNT', message: 'A workflow needs exactly one trigger node.' })
  for (const edge of graph.edges) {
    if (!ids.has(edge.source)) issues.push({ level: 'error', code: 'MISSING_EDGE_SOURCE', message: `Edge source "${edge.source}" does not exist.` })
    if (!ids.has(edge.target)) issues.push({ level: 'error', code: 'MISSING_EDGE_TARGET', message: `Edge target "${edge.target}" does not exist.` })
    if (edge.source === edge.target) issues.push({ level: 'error', code: 'SELF_EDGE', message: 'A node cannot connect to itself.', nodeId: edge.source })
  }
  return issues
}

export class FlowBuilder {
  private graph: WorkflowGraph = { schemaVersion: 2, nodes: [], edges: [] }

  static fromJSON(value: unknown): FlowBuilder {
    const source = record(value, 'Workflow graph')
    const builder = new FlowBuilder()
    builder.graph = {
      schemaVersion: 2,
      nodes: Array.isArray(source.nodes) ? clone(source.nodes) as WorkflowNode[] : [],
      edges: Array.isArray(source.edges) ? clone(source.edges) as WorkflowEdge[] : [],
      ...(source.pinData && typeof source.pinData === 'object' && !Array.isArray(source.pinData) ? { pinData: clone(source.pinData) as Record<string, unknown> } : {}),
    }
    const issues = validateWorkflow(builder.graph).filter((issue) => issue.code !== 'TRIGGER_COUNT')
    if (issues.length) throw new Error(issues.map((issue) => issue.message).join('; '))
    return builder
  }

  trigger(config: Record<string, unknown> = { type: 'manual' }): this {
    const existing = this.graph.nodes.find((node) => node.type === 'trigger')
    const node: WorkflowNode = {
      id: existing?.id ?? 'trigger',
      type: 'trigger',
      typeVersion: 1,
      data: { trigger: clone(config) },
      position: existing?.position ?? { x: 0, y: 0 },
    }
    if (existing) this.graph.nodes = this.graph.nodes.map((entry) => entry.id === existing.id ? node : entry)
    else this.graph.nodes.unshift(node)
    return this
  }

  node<TData extends Record<string, unknown>>(
    type: Exclude<NodeType, 'trigger'>,
    data: TData,
    options: { id?: string; typeVersion?: number; position?: { x: number; y: number }; disabled?: boolean } = {},
  ): string {
    const id = options.id?.trim() || nextId(type)
    if (this.graph.nodes.some((node) => node.id === id)) throw new Error(`Node id "${id}" already exists.`)
    this.graph.nodes.push({ id, type, typeVersion: options.typeVersion ?? 1, data: clone(data), ...(options.position ? { position: options.position } : {}), ...(options.disabled ? { disabled: true } : {}) })
    return id
  }

  connect(source: string, target: string, options: Omit<WorkflowEdge, 'id' | 'source' | 'target'> & { id?: string } = {}): this {
    if (!this.graph.nodes.some((node) => node.id === source)) throw new Error(`Unknown source node "${source}".`)
    if (!this.graph.nodes.some((node) => node.id === target)) throw new Error(`Unknown target node "${target}".`)
    const { id = nextId('edge'), ...ports } = options
    if (this.graph.edges.some((edge) => edge.id === id)) throw new Error(`Edge id "${id}" already exists.`)
    this.graph.edges.push({ id, source, target, ...ports })
    return this
  }

  pin(nodeId: string, value: unknown): this {
    if (!this.graph.nodes.some((node) => node.id === nodeId)) throw new Error(`Unknown node "${nodeId}".`)
    this.graph.pinData = { ...this.graph.pinData, [nodeId]: clone(value) }
    return this
  }

  toJSON(options: { validate?: boolean } = { validate: true }): WorkflowGraph {
    const graph = clone(this.graph)
    if (options.validate !== false) {
      const errors = validateWorkflow(graph).filter((issue) => issue.level === 'error')
      if (errors.length) throw new Error(errors.map((issue) => `${issue.code}: ${issue.message}`).join('; '))
    }
    return graph
  }
}

export const workflow = () => new FlowBuilder()

export type JsonSchema = Record<string, unknown>

export type ToolContext = {
  signal: AbortSignal
  organizationId?: string
  userId?: string
  metadata?: Record<string, unknown>
}

export type ToolDefinition<TArgs extends Record<string, unknown> = Record<string, unknown>, TResult = unknown> = {
  name: string
  description: string
  inputSchema: JsonSchema
  isWrite?: boolean
  execute: (args: TArgs, context: ToolContext) => Promise<TResult> | TResult
}

export type GuardrailResult = { allowed: true } | { allowed: false; reason: string }
export type Guardrail<T = unknown> = {
  name: string
  phase: 'input' | 'tool' | 'output'
  check: (value: T, context: ToolContext) => Promise<GuardrailResult> | GuardrailResult
}

export type MemoryRecord = { id: string; content: string; metadata?: Record<string, unknown>; createdAt?: string }
export type MemoryProvider = {
  search: (query: string, limit: number, context: ToolContext) => Promise<MemoryRecord[]>
  save: (record: Omit<MemoryRecord, 'id'>, context: ToolContext) => Promise<MemoryRecord>
}

export type McpSource = {
  name: string
  url: string
  headers?: Record<string, string>
  allowedTools?: string[]
}

export type AgentDefinition = {
  name: string
  instructions: string
  model?: string
  tools: ToolDefinition[]
  guardrails: Guardrail[]
  memory?: MemoryProvider
  mcp: McpSource[]
  subagents: AgentDefinition[]
  maxTurns?: number
  maxCostUsd?: number
}

export function defineTool<TArgs extends Record<string, unknown>, TResult>(definition: ToolDefinition<TArgs, TResult>): ToolDefinition<TArgs, TResult> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(definition.name)) throw new Error('Tool names must be 1-64 letters, numbers, underscores, or hyphens.')
  return Object.freeze({ ...definition })
}

export function defineGuardrail<T>(guardrail: Guardrail<T>): Guardrail<T> {
  if (!guardrail.name.trim()) throw new Error('Guardrail name is required.')
  return Object.freeze({ ...guardrail })
}

export function defineAgent(definition: Omit<AgentDefinition, 'tools' | 'guardrails' | 'mcp' | 'subagents'> & Partial<Pick<AgentDefinition, 'tools' | 'guardrails' | 'mcp' | 'subagents'>>): AgentDefinition {
  if (!definition.name.trim()) throw new Error('Agent name is required.')
  if (!definition.instructions.trim()) throw new Error('Agent instructions are required.')
  const agent: AgentDefinition = {
    ...definition,
    tools: [...(definition.tools ?? [])],
    guardrails: [...(definition.guardrails ?? [])],
    mcp: [...(definition.mcp ?? [])],
    subagents: [...(definition.subagents ?? [])],
  }
  const toolNames = agent.tools.map((tool) => tool.name)
  if (new Set(toolNames).size !== toolNames.length) throw new Error('Agent tool names must be unique.')
  const visited = new Set<AgentDefinition>()
  const stack = new Set<AgentDefinition>()
  const visit = (entry: AgentDefinition) => {
    if (stack.has(entry)) throw new Error('Agent subagent graph contains a cycle.')
    if (visited.has(entry)) return
    stack.add(entry)
    entry.subagents.forEach(visit)
    stack.delete(entry)
    visited.add(entry)
  }
  visit(agent)
  return Object.freeze(agent)
}

import { createHash } from 'node:crypto'
import type { FlowGraph } from '@/lib/flows/graph'

type AgentRevision = { id: string; updatedAt: Date | string }
type ToolRevision = {
  id: string
  tools?: { name: string; inputSchema?: unknown; outputSchema?: unknown }[]
}

export type FlowExecutionManifest = {
  version: 1
  graphHash: string
  dependencyHash: string
  agents: { id: string; updatedAt: string }[]
  tools: { connectionId: string; name: string; schemaHash: string }[]
  models: { agent: string; summary: string }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function manifestHash(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex')
}

export function buildFlowExecutionManifest(params: {
  graph: FlowGraph
  agents: AgentRevision[]
  toolCatalog: ToolRevision[]
  agentModel: string
  summaryModel: string
}): FlowExecutionManifest {
  const usedAgentIds = new Set(params.graph.nodes.flatMap((node) => node.type === 'agent' ? [node.data.agentId] : []))
  const usedTools = new Set(params.graph.nodes.flatMap((node) =>
    node.type === 'tool' ? [`${node.data.connectionId}\u0000${node.data.toolName}`] : [],
  ))
  const agents = params.agents
    .filter((agent) => usedAgentIds.has(agent.id))
    .map((agent) => ({ id: agent.id, updatedAt: new Date(agent.updatedAt).toISOString() }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const tools = params.toolCatalog.flatMap((connection) =>
    (connection.tools ?? [])
      .filter((tool) => usedTools.has(`${connection.id}\u0000${tool.name}`))
      .map((tool) => ({
        connectionId: connection.id,
        name: tool.name,
        schemaHash: manifestHash({ input: tool.inputSchema ?? null, output: tool.outputSchema ?? null }),
      })),
  ).sort((a, b) => `${a.connectionId}:${a.name}`.localeCompare(`${b.connectionId}:${b.name}`))
  const dependencies = { agents, tools, models: { agent: params.agentModel, summary: params.summaryModel } }
  return {
    version: 1,
    graphHash: manifestHash(params.graph),
    dependencyHash: manifestHash(dependencies),
    ...dependencies,
  }
}

/**
 * Hash of the dependencies that genuinely invalidate a pinned run: agent
 * revisions and tool schemas. Model ids are deliberately excluded — they are
 * env-derived defaults (AGENT_MODEL/SUMMARY_MODEL), and the manifest is pinned
 * on the web process but re-checked on the worker fleet, which resolves its
 * own env. A default-model difference between the two planes (or a deploy
 * changing the default) must not fail runs whose graph and dependencies are
 * untouched. Computed from the stored agents/tools arrays so manifests pinned
 * before this distinction existed compare correctly too.
 */
function dependencyIntegrityHash(value: Pick<FlowExecutionManifest, 'agents' | 'tools'>): string {
  return manifestHash({ agents: value.agents ?? [], tools: value.tools ?? [] })
}

export function executionManifestMatches(pinned: unknown, current: FlowExecutionManifest): boolean {
  if (!pinned || typeof pinned !== 'object' || Array.isArray(pinned)) return true // legacy run
  const value = pinned as Partial<FlowExecutionManifest>
  if (value.version !== 1 || value.graphHash !== current.graphHash) return false
  if (value.dependencyHash === current.dependencyHash) return true
  return dependencyIntegrityHash(value as Pick<FlowExecutionManifest, 'agents' | 'tools'>) === dependencyIntegrityHash(current)
}

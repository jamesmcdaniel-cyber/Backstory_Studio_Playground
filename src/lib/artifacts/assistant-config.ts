import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { loadFlowToolCatalog } from '@/lib/flows/tool-catalog'
import { resolveAgentConnectorKeys } from '@/lib/connectors/agent-connectors'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'
import { ASSISTANT_INSTRUCTIONS_MAX, ASSISTANT_TOOLS_MAX, readAssistantConfig, type AssistantConfig } from './assistant-settings'

export { assistantConfigSchema, readAssistantConfig, type AssistantConfig } from './assistant-settings'

/**
 * The artifact assistant's settings — what a person can tune without opening
 * the agent: standing instructions the assistant follows on every message,
 * and connected tools it may use beyond the agent's own. The agent's tools
 * always apply; MCP connections and Sales AI load for every run anyway; the
 * toggles are for the workspace's other connected integrations. Granted per
 * run the same way a flow step grants tools (stepOverrides.toolConnectionIds).
 */

/** Built-in planes every artifact assistant has regardless of settings. */
const ALWAYS_NATIVE = new Set(['repository', 'code', 'artifact', 'roi'])

export type AssistantToolOption = {
  id: string
  name: string
  tools: number
  /** agent: the producing agent's own; always: loads for every run; optional: the person's to turn on. */
  source: 'agent' | 'always' | 'optional'
  enabled: boolean
  error?: string
}

export type AssistantSetup = { config: AssistantConfig; agent: { id: string; title: string } | null; tools: AssistantToolOption[] }

/** The settings and the tool options for an artifact's assistant, for the person viewing it. */
export async function loadAssistantSetup(organizationId: string, userId: string, artifactId: string): Promise<AssistantSetup | null> {
  const artifact = await prisma.artifact.findFirst({ where: { id: artifactId, organizationId }, select: { agentTaskId: true, assistantConfig: true } })
  if (!artifact) return null
  const config = readAssistantConfig(artifact.assistantConfig)
  const agent = artifact.agentTaskId
    ? await prisma.agentTask.findFirst({ where: { id: artifact.agentTaskId, organizationId }, select: { id: true, description: true, metadata: true } })
    : null
  const agentKeys = new Set(agent ? await resolveAgentConnectorKeys(agent.id, agent.metadata as Record<string, unknown> | null) : [])
  const catalog = await loadFlowToolCatalog(organizationId, { userId, takeConnections: 25, takeTools: 200 }).catch(() => [])
  const tools: AssistantToolOption[] = catalog.map((connection) => {
    const { plane, ref } = parseFlowToolConnectionId(connection.id)
    const source: AssistantToolOption['source'] = plane === 'mcp' || plane === 'people_ai' || ALWAYS_NATIVE.has(ref)
      ? 'always'
      : agentKeys.has(ref) ? 'agent' : 'optional'
    return {
      id: connection.id,
      name: connection.name,
      tools: connection.tools.length,
      source,
      enabled: source !== 'optional' || config.toolConnectionIds.includes(connection.id),
      ...(connection.toolsError ? { error: connection.toolsError } : {}),
    }
  })
  const order = { agent: 0, optional: 1, always: 2 }
  tools.sort((a, b) => order[a.source] - order[b.source] || a.name.localeCompare(b.name))
  const title = agent ? ((agent.metadata as { title?: unknown } | null)?.title as string | undefined) || agent.description.split('\n')[0] : ''
  return { config, agent: agent ? { id: agent.id, title } : null, tools }
}

/**
 * Save the settings. Only tools this workspace has connected, and that are
 * not already the agent's, can be granted — anything else is dropped.
 */
export async function saveAssistantConfig(organizationId: string, userId: string, artifactId: string, input: AssistantConfig): Promise<AssistantSetup | null> {
  const setup = await loadAssistantSetup(organizationId, userId, artifactId)
  if (!setup) return null
  const grantable = new Set(setup.tools.filter((tool) => tool.source === 'optional').map((tool) => tool.id))
  const config: AssistantConfig = {
    instructions: input.instructions.trim().slice(0, ASSISTANT_INSTRUCTIONS_MAX),
    toolConnectionIds: [...new Set(input.toolConnectionIds)].filter((id) => grantable.has(id)).slice(0, ASSISTANT_TOOLS_MAX),
  }
  await prisma.artifact.update({ where: { id: artifactId, organizationId }, data: { assistantConfig: config as unknown as Prisma.InputJsonValue } })
  return loadAssistantSetup(organizationId, userId, artifactId)
}

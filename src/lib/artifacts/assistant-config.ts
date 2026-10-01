import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { ApiError } from '@/lib/server/api-handler'
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
/** Built-in tools (not integrations): no account behind them, shown apart. */
const BUILTIN_NATIVE = new Set(['repository', 'code', 'artifact', 'roi', 'http', 'data_tables', 'adapters'])

export type AssistantToolOption = {
  /** One row per integration: every tool connection id it covers (Gmail's read, list and send are one row). */
  key: string
  ids: string[]
  name: string
  /** Logo slug for an integration ("gmail", "slack", "n8n"); null for a built-in tool. */
  slug: string | null
  kind: 'integration' | 'builtin'
  tools: number
  /** agent: the producing agent's own; always: loads for every run; optional: the person's to turn on. */
  source: 'agent' | 'always' | 'optional'
  enabled: boolean
}

export type AssistantSetup = { config: AssistantConfig; agent: { id: string; title: string } | null; tools: AssistantToolOption[] }

function slugOf(name: string): string {
  return name.toLowerCase().replace(/\(.*?\)/g, '').replace(/\bmcp\b/g, '').trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/** The settings and the tool options for an artifact's assistant, for the person viewing it. */
export async function loadAssistantSetup(organizationId: string, userId: string, artifactId: string): Promise<AssistantSetup | null> {
  const artifact = await prisma.artifact.findFirst({ where: { id: artifactId, organizationId }, select: { agentTaskId: true, assistantConfig: true, templateSourceId: true } })
  if (!artifact) return null
  if (artifact.templateSourceId) throw new ApiError('Template copy configuration is locked.', 403, 'CONFIGURATION_LOCKED')
  const config = readAssistantConfig(artifact.assistantConfig)
  const agent = artifact.agentTaskId
    ? await prisma.agentTask.findFirst({ where: { id: artifact.agentTaskId, organizationId }, select: { id: true, description: true, metadata: true } })
    : null
  const agentKeys = new Set(agent ? await resolveAgentConnectorKeys(agent.id, agent.metadata as Record<string, unknown> | null) : [])
  const catalog = await loadFlowToolCatalog(organizationId, { userId, takeConnections: 25, takeTools: 200 }).catch(() => [])
  const rows = new Map<string, AssistantToolOption>()
  for (const connection of catalog) {
    // Only what works: a connection whose tools could not load (an expired
    // sign-in) is not something the assistant can use.
    if (connection.toolsError || !connection.tools.length) continue
    const { plane, ref } = parseFlowToolConnectionId(connection.id)
    const builtin = plane === 'native' && BUILTIN_NATIVE.has(ref)
    const provider = plane === 'nango' ? connection.provider ?? ref : null
    const key = provider ? `nango:${provider}` : connection.id
    const source: AssistantToolOption['source'] = plane === 'mcp' || plane === 'people_ai' || ALWAYS_NATIVE.has(ref)
      ? 'always'
      : agentKeys.has(ref) || (provider !== null && agentKeys.has(provider)) ? 'agent' : 'optional'
    const existing = rows.get(key)
    if (existing) {
      existing.ids.push(connection.id)
      existing.tools += connection.tools.length
      // "Slack (send)" and "Slack": the integration is "Slack".
      if (connection.name.length < existing.name.length) existing.name = connection.name
      if (source === 'agent') existing.source = 'agent'
      continue
    }
    rows.set(key, {
      key,
      ids: [connection.id],
      name: connection.name.replace(/\s*\(.*?\)\s*$/, ''),
      slug: builtin ? null : provider ?? (plane === 'people_ai' ? 'backstory' : slugOf(connection.name)),
      kind: builtin ? 'builtin' : 'integration',
      tools: connection.tools.length,
      source,
      enabled: false,
    })
  }
  const tools = [...rows.values()].map((row) => ({ ...row, enabled: row.source !== 'optional' || row.ids.some((id) => config.toolConnectionIds.includes(id)) }))
  const order = { agent: 0, optional: 1, always: 2 }
  tools.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'integration' ? -1 : 1) || order[a.source] - order[b.source] || a.name.localeCompare(b.name))
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
  const grantable = new Set(setup.tools.filter((tool) => tool.source === 'optional').flatMap((tool) => tool.ids))
  const config: AssistantConfig = {
    instructions: input.instructions.trim().slice(0, ASSISTANT_INSTRUCTIONS_MAX),
    toolConnectionIds: [...new Set(input.toolConnectionIds)].filter((id) => grantable.has(id)).slice(0, ASSISTANT_TOOLS_MAX),
  }
  await prisma.artifact.update({ where: { id: artifactId, organizationId }, data: { assistantConfig: config as unknown as Prisma.InputJsonValue } })
  return loadAssistantSetup(organizationId, userId, artifactId)
}

/**
 * The scope card's server side: "What this agent can do", derived from the
 * runtime's OWN tool resolution — never a parallel reading of settings.
 *
 *   tools, read/write, Integrations "Needs approval"/"Blocked", per-agent
 *   allowlist exclusions  →  groupToolDecisions + toolBindingFor
 *                             (the functions loadTools uses)
 *   the agent's own approval  →  requiresApproval, the gate's own predicate
 *   attached integrations, published pin  →  agentToolConfig
 *   whose account  →  each plane's PlaneCredential, set by its loader
 *
 * Resolved for the person asking: agents act as whoever runs them, so "your
 * Gmail" is only true for you. Scheduled and signal-started runs act as the
 * agent's owner, which the card says separately.
 *
 * Deliberately left to the run itself: the 64-tool cap and relevance selection
 * (noted on the card when it applies), a flow step's tool policy, and the
 * template-copilot path (those agents never appear on the roster).
 */

import { prisma } from '@/lib/prisma'
import { requiresApproval } from '@/lib/agents/approval'
import { applyPublishedDefinition, type PublishableAgent } from '@/lib/agents/publish'
import { readAgentMetadata } from '@/lib/agents/metadata'
import { compensationFor } from '@/lib/nango/compensators'
import { humanizeToolName, mcpReportsWrite } from '@/lib/mcp/tool-policy'
import { describeSchedule, type ScheduleLike } from '@/lib/scheduling/cadence'
import type { AgentToolSettings } from '@/lib/connectors/tool-quick-config'
import {
  countScope,
  summarizeScope,
  type AgentScope,
  type AgentScopeSummary,
  type ScopeActsAs,
  type ScopeConnection,
  type ScopeTool,
  type ScopeToolAccess,
  type ScopeTrigger,
} from '@/lib/agents/scope-types'
import { agentToolConfig, groupToolDecisions, loadAgentToolGroups } from './agent-tool-resolution'
import type { ToolPlaneGroup } from './tool-planes'

/** The runtime's tool budget per run (execute-agent TOOL_CAP). */
const RUN_TOOL_CAP = 64

function accessOf(group: ToolPlaneGroup, decision: ReturnType<typeof groupToolDecisions>[number]): ScopeToolAccess {
  // MCP tools are never classified by the runtime (it treats them all as
  // reads); what the server itself says is the only honest answer, and no
  // annotation means we do not know.
  if (group.plane === 'mcp') {
    const reported = mcpReportsWrite(decision.tool.annotations)
    return reported === null ? 'unclassified' : reported ? 'write' : 'read'
  }
  const binding = decision.binding
  if (binding?.isWriteFor || (!binding && group.isWriteFor)) return 'depends'
  return (binding?.isWrite ?? group.isWrite) ? 'write' : 'read'
}

/**
 * The card's connections, from the runtime's groups and per-tool decisions.
 * Pure: exported for the test that pins the card to the runtime.
 */
export function scopeConnectionsFromGroups(
  groups: ToolPlaneGroup[],
  toolSettings: AgentToolSettings,
  agentMetadata: Record<string, unknown>,
): ScopeConnection[] {
  const byKey = new Map<string, ScopeConnection>()
  for (const group of groups) {
    // Nango provider tools arrive one group per tool; a person thinks in
    // accounts, so they fold into one connection per provider.
    const key = `${group.plane}:${group.provider}`
    const actsAs: ScopeActsAs = group.credential?.actsAs ?? (group.plane === 'native' ? 'workspace' : 'none')
    let connection = byKey.get(key)
    if (!connection) {
      connection = { key, name: group.name.replace(/ \(send\)$/, ''), plane: group.plane, provider: group.provider, actsAs, tools: [] }
      byKey.set(key, connection)
    }
    if (!group.client) {
      if (group.toolsError && !connection.tools.length) connection.unavailable = group.toolsError
      continue
    }
    delete connection.unavailable
    connection.actsAs = actsAs
    for (const decision of groupToolDecisions(group, toolSettings)) {
      if (connection.tools.some((tool) => tool.name === decision.tool.name)) continue
      const access = accessOf(group, decision)
      const tool: ScopeTool = { name: decision.tool.name, label: decision.tool.title || humanizeToolName(decision.tool.name), access, status: 'allowed' }
      if (!decision.exposed) {
        tool.status = 'blocked'
        if (decision.blockedBy) tool.blockedBy = decision.blockedBy
      } else if (decision.binding?.needsApproval) {
        tool.status = 'needs_approval'
        tool.approvalBy = 'integration'
      } else if ((access === 'write' || access === 'depends') && requiresApproval(agentMetadata, decision.binding!.provider, true)) {
        // The gate's own predicate, asked about a write on this binding.
        tool.status = 'needs_approval'
        tool.approvalBy = 'agent'
      }
      if (access === 'write' || access === 'depends') {
        const compensation = compensationFor({ plane: group.plane, provider: group.provider, tool: decision.tool.name })
        tool.undo = compensation.undoable ? { undoable: true, note: compensation.effect } : { undoable: false, note: compensation.reason }
      }
      connection.tools.push(tool)
    }
  }
  // Two connections can share a display name (the workspace Slack bot and your
  // own Slack account); say which is which.
  const connections = [...byKey.values()]
  for (const connection of connections) {
    if (connections.some((other) => other !== connection && other.name === connection.name) && connection.plane === 'native') {
      connection.name = `${connection.name} (workspace)`
    }
  }
  return connections
}

type ScopeAgentRow = PublishableAgent & {
  id: string
  userId: string | null
  schedule: unknown
  metadata: unknown
}

/** Everything on the card that is not a tool: triggers, data scope, owner. */
async function agentFacts(organizationId: string, agent: ScopeAgentRow, metadata: ReturnType<typeof readAgentMetadata>) {
  const [owner, signals, channelCount, commands, agentDocuments, collections] = await Promise.all([
    agent.userId ? prisma.user.findFirst({ where: { id: agent.userId }, select: { name: true, email: true } }) : null,
    prisma.signalSubscription.findMany({ where: { organizationId, agentTaskId: agent.id, isActive: true }, select: { signalType: true }, take: 20 }),
    prisma.slackChannelBinding.count({ where: { organizationId, agentTaskId: agent.id } }),
    prisma.slackCommandBinding.findMany({ where: { organizationId, agentTaskId: agent.id }, select: { command: true }, take: 10 }),
    prisma.knowledgeDocument.count({ where: { organizationId, agentId: agent.id } }),
    prisma.agentKnowledgeCollection.findMany({
      where: { organizationId, agentId: agent.id },
      select: { collection: { select: { id: true, name: true } } },
      take: 50,
    }),
  ])
  const triggers: ScopeTrigger[] = []
  const schedule = (agent.schedule && typeof agent.schedule === 'object' ? agent.schedule : {}) as ScheduleLike & { isActive?: boolean; timezone?: string }
  if (schedule.isActive !== false && schedule.type && schedule.type !== 'manual') {
    triggers.push({ kind: 'schedule', description: `Runs ${describeSchedule(schedule)}${schedule.timezone ? ` (${schedule.timezone})` : ''}` })
  }
  if (metadata.triggerSecretHash) triggers.push({ kind: 'webhook' })
  for (const signal of signals) triggers.push({ kind: 'signal', description: signal.signalType.replace(/[_.-]+/g, ' ') })
  if (channelCount) triggers.push({ kind: 'slack_channel', count: channelCount })
  for (const binding of commands) triggers.push({ kind: 'slack_command', command: binding.command })
  return {
    ownerName: owner?.name || owner?.email || null,
    triggers,
    data: { agentDocuments, collections: collections.map((row) => row.collection) },
  }
}

/**
 * The full scope of one agent, for the person asking. `groupsFor` lets the
 * roster share one plane load across agents with the same attachments.
 */
export async function resolveAgentScope(params: {
  organizationId: string
  agent: ScopeAgentRow
  viewerUserId: string
  groupsFor?: (key: string, load: () => Promise<ToolPlaneGroup[]>) => Promise<ToolPlaneGroup[]>
}): Promise<AgentScope> {
  const { organizationId, viewerUserId } = params
  // The definition a run executes: the published one when there is one.
  const agent = applyPublishedDefinition(params.agent)
  const metadata = readAgentMetadata(agent.metadata)
  const agentMetadata = metadata as Record<string, unknown>
  const { providers, toolSettings, httpEndpoints } = await agentToolConfig(agent, agentMetadata)
  const load = () => loadAgentToolGroups({ organizationId, providers, ownerUserId: viewerUserId, httpEndpoints, agentId: agent.id })
  const groupKey = JSON.stringify([...providers].sort().concat(httpEndpoints.map((endpoint) => endpoint.name)))
  const [groups, facts] = await Promise.all([
    params.groupsFor ? params.groupsFor(groupKey, load) : load(),
    agentFacts(organizationId, params.agent, metadata),
  ])
  const connections = scopeConnectionsFromGroups(groups, toolSettings, agentMetadata)
  const counts = countScope(connections)
  const agentRequiresApproval = metadata.requireApproval === true
  const notCoveredByAgentApproval = agentRequiresApproval
    ? connections
        .filter((connection) => connection.tools.some((tool) => (tool.access === 'write' || tool.access === 'depends') && tool.status === 'allowed'))
        .map((connection) => connection.name)
    : []
  const notes: string[] = []
  if (counts.tools > RUN_TOOL_CAP) {
    notes.push(`A run is handed at most ${RUN_TOOL_CAP} of these ${counts.tools} tools, picked by how well they fit the task. Write tools are kept first.`)
  }
  if (counts.writes > 0) {
    notes.push('When this agent runs as a step inside a flow, its own approval setting is skipped, and tools set to Needs approval in Integrations are refused there.')
  }
  if (agentRequiresApproval) {
    notes.push('A run that has read content flagged as a possible prompt injection must get approval before any write through a connected account.')
  }
  return {
    agentId: agent.id,
    resolvedFor: 'viewer',
    counts,
    connections,
    identity: { ownerName: facts.ownerName },
    approval: { agentRequiresApproval, notCoveredByAgentApproval },
    data: facts.data,
    triggers: facts.triggers,
    notes,
  }
}

/** Load each distinct attachment set once, for a roster of agents. */
export function sharedGroupLoader(): (key: string, load: () => Promise<ToolPlaneGroup[]>) => Promise<ToolPlaneGroup[]> {
  const cache = new Map<string, Promise<ToolPlaneGroup[]>>()
  return (key, load) => {
    let pending = cache.get(key)
    if (!pending) {
      pending = load()
      cache.set(key, pending)
    }
    return pending
  }
}

/** Compact scopes for a roster, a few agents at a time. */
export async function resolveRosterScopes(params: {
  organizationId: string
  agents: ScopeAgentRow[]
  viewerUserId: string
}): Promise<Record<string, AgentScopeSummary>> {
  const groupsFor = sharedGroupLoader()
  const out: Record<string, AgentScopeSummary> = {}
  const queue = [...params.agents]
  const worker = async () => {
    for (let agent = queue.shift(); agent; agent = queue.shift()) {
      try {
        out[agent.id] = summarizeScope(await resolveAgentScope({ organizationId: params.organizationId, agent, viewerUserId: params.viewerUserId, groupsFor }))
      } catch {
        // One agent's scope failing must not blank the roster; its card just
        // shows no scope line.
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))
  return out
}

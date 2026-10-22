/**
 * How an agent's tools are resolved — ONE implementation, two readers.
 *
 * The runtime (execute-agent's loadTools) and the scope card ("What this agent
 * can do", @/features/agents/agent-scope) both call these functions. Nothing
 * here decides policy on its own: the planes come from the same loaders, the
 * per-tool decision (exposed, blocked in Integrations, turned off for this
 * agent) is made once in `groupToolDecisions`, and each exposed tool's binding
 * — which carries the write classification and the approval flag the gate
 * reads — is built once in `toolBindingFor`.
 *
 * That is the point of the module: a card that re-derived "can this agent
 * write to Slack?" from settings by its own logic would drift from the run the
 * first time either changed, and a trust surface that is wrong is worse than
 * none. agent-scope.test.ts pins the two readers together.
 */

import {
  loadMcpConnectionPlaneGroups,
  loadNangoPlaneGroups,
  loadNativePlaneGroups,
  loadPeopleAiPlaneGroup,
  toolName,
  type PlaneToolDescriptor,
  type ToolBinding,
  type ToolPlaneGroup,
} from './tool-planes'
import { mcpReportsWrite } from '@/lib/mcp/tool-policy'
import { mcpAllowedToolNames, parseAgentToolSettings, type AgentToolSettings } from '@/lib/connectors/tool-quick-config'
import { parseAgentHttpEndpoints, type AgentHttpEndpoint } from '@/lib/integrations/http-endpoints'
import { resolveAgentConnectorKeys } from '@/lib/connectors/agent-connectors'
import { pinnedConnectorKeys, type PublishableAgent } from '@/lib/agents/publish'

/** A run started from an artifact's chat (binds the artifact plane to it). */
export type ArtifactRunContext = {
  artifactId: string
  kind: string
  executionId: string
  request: string | null
  expectedVersionId?: string
  templateCopy?: boolean
  guestCopy?: boolean
}

// A tool discovered from some plane, before the global cap is applied. `isWrite`
// marks consequential outbound-delivery tools so they can be reserved a slice of
// the cap instead of being crowded out by many read tools.
export type DiscoveredTool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  binding: ToolBinding
  isWrite: boolean
}

/** An integration attached to the agent that produced no usable client. */
export type UnavailableTool = { name: string; reason: string; isWrite: boolean }

/**
 * The tool-relevant parts of an agent's definition: which integrations are
 * attached (the published pin when there is one — publishing pins the tools as
 * well as the words — else the typed bindings, else metadata.integrations),
 * its per-tool settings and its configured API endpoints.
 *
 * `agent` is the row as a run executes it: already overlaid with its published
 * definition (applyPublishedDefinition).
 */
export async function agentToolConfig(
  agent: PublishableAgent & { id: string },
  agentMetadata: Record<string, unknown>,
): Promise<{ providers: string[]; toolSettings: AgentToolSettings; httpEndpoints: AgentHttpEndpoint[] }> {
  const providers = pinnedConnectorKeys(agent) ?? (await resolveAgentConnectorKeys(agent.id, agentMetadata))
  return {
    providers: [...providers],
    toolSettings: parseAgentToolSettings(agentMetadata.toolSettings),
    httpEndpoints: parseAgentHttpEndpoints(agentMetadata.httpEndpoints),
  }
}

/**
 * The planes a normal (non-template-copy) agent run draws from, in the order
 * the runtime registers them — order matters, because a duplicate tool name
 * keeps its FIRST registration.
 *
 * 'repository' and 'code' ride along unconditionally (see loadTools); an ROI
 * dashboard's conversation also gets the ROI plane.
 */
export async function loadAgentToolGroups(params: {
  organizationId: string
  providers: string[]
  /** The person the run acts as — agents act as whoever runs them. */
  ownerUserId?: string | null
  httpEndpoints?: AgentHttpEndpoint[]
  agentId?: string
  artifact?: ArtifactRunContext
}): Promise<ToolPlaneGroup[]> {
  const { organizationId, providers, ownerUserId, artifact } = params
  const nativeProviders = artifact?.kind === 'roi_dashboard' ? [...providers, 'repository', 'code', 'roi'] : [...providers, 'repository', 'code']
  const [peopleAiGroup, mcpGroups, nativeGroups, nangoGroups] = await Promise.all([
    loadPeopleAiPlaneGroup(organizationId, ownerUserId),
    loadMcpConnectionPlaneGroups(organizationId, ownerUserId),
    loadNativePlaneGroups(organizationId, {
      providers: nativeProviders,
      httpEndpoints: params.httpEndpoints ?? [],
      httpUserId: ownerUserId ?? undefined,
      agentId: params.agentId,
      artifact,
    }),
    loadNangoPlaneGroups(organizationId, ownerUserId, { providers }),
  ])
  return [...(peopleAiGroup ? [peopleAiGroup] : []), ...mcpGroups, ...nativeGroups, ...nangoGroups]
}

/** The model-facing name prefix a group's tools are registered under. */
export function toolNamePrefix(group: ToolPlaneGroup): string {
  return group.plane === 'nango' ? 'nango' : group.provider
}

/**
 * The binding the runtime executes a tool through. `isWrite`/`isWriteFor` feed
 * the approval gate, the read-only step policy and the audit; `needsApproval`
 * is the per-tool "Needs approval" set in Integrations.
 */
export function toolBindingFor(group: ToolPlaneGroup, tool: PlaneToolDescriptor): ToolBinding {
  return {
    provider: group.provider,
    serverUrl: group.serverUrl,
    toolName: tool.name,
    isWrite: group.isWrite,
    ...(group.isWriteFor ? { isWriteFor: (args: Record<string, unknown>) => group.isWriteFor!(tool.name, args) } : {}),
    client: group.client!,
    ...(group.plane === 'mcp' ? { mcpConnectionId: group.id } : {}),
    ...(tool.policy === 'approve' ? { needsApproval: true } : {}),
    ...(group.credential ? { credential: group.credential } : {}),
    ...(group.plane === 'mcp' && mcpReportsWrite(tool.annotations) === true ? { reportsWrite: true } : {}),
  }
}

/** One tool of one group, and whether a run gets it. */
export type ToolDecision = {
  /** Model-facing registered name. */
  name: string
  tool: PlaneToolDescriptor
  /** True when a run is handed this tool (before the global cap). */
  exposed: boolean
  /** Why it is withheld: turned off in Integrations, or not on this agent's allowlist. */
  blockedBy?: 'integration' | 'agent'
  /** Present exactly when `exposed`. */
  binding?: ToolBinding
}

/**
 * Every tool a group carries, decided. MCP tools turned off in Integrations
 * never leave the loader (they arrive as `blockedTools` names); they are
 * listed here as withheld so the card can say so. A per-agent allowlist
 * (agent setup → MCP chip gear) withholds the rest of that server's tools.
 * A group without a client contributes nothing — it is reported unavailable.
 */
export function groupToolDecisions(group: ToolPlaneGroup, toolSettings: AgentToolSettings = {}): ToolDecision[] {
  const prefix = toolNamePrefix(group)
  const allowed = group.plane === 'mcp' ? mcpAllowedToolNames(toolSettings, group.id) : null
  const decisions: ToolDecision[] = []
  for (const tool of group.tools) {
    const name = toolName(prefix, tool.name)
    // Belt and braces: the MCP loader already withholds blocked tools.
    if (tool.policy === 'off') {
      decisions.push({ name, tool, exposed: false, blockedBy: 'integration' })
      continue
    }
    if (allowed && !allowed.has(tool.name)) {
      decisions.push({ name, tool, exposed: false, blockedBy: 'agent' })
      continue
    }
    if (!group.client) {
      decisions.push({ name, tool, exposed: false })
      continue
    }
    decisions.push({ name, tool, exposed: true, binding: toolBindingFor(group, tool) })
  }
  for (const blocked of group.blockedTools ?? []) {
    if (group.tools.some((tool) => tool.name === blocked)) continue
    decisions.push({ name: toolName(prefix, blocked), tool: { name: blocked, description: '', policy: 'off' }, exposed: false, blockedBy: 'integration' })
  }
  return decisions
}

/**
 * What loadTools hands the cap/selection step: every exposed tool, plus the
 * attached planes that produced no client (so the run can say which
 * integration is unavailable and why instead of acting as if none existed).
 */
export function discoveredToolsFromGroups(
  groups: ToolPlaneGroup[],
  toolSettings: AgentToolSettings = {},
): { discovered: DiscoveredTool[]; unavailable: UnavailableTool[] } {
  const discovered: DiscoveredTool[] = []
  const unavailable: UnavailableTool[] = []
  for (const group of groups) {
    if (!group.client) {
      // isWrite matters downstream: a missing DELIVERY integration is a
      // blocker (the run cannot do the thing it was asked to do), while a
      // missing read source only narrows what it had to work with.
      if (group.toolsError) unavailable.push({ name: group.name, reason: group.toolsError, isWrite: group.isWrite })
      continue
    }
    for (const decision of groupToolDecisions(group, toolSettings)) {
      if (!decision.exposed || !decision.binding) continue
      discovered.push({
        name: decision.name,
        description: decision.tool.description,
        inputSchema: (decision.tool.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
        binding: decision.binding,
        isWrite: decision.binding.isWrite,
      })
    }
  }
  return { discovered, unavailable }
}

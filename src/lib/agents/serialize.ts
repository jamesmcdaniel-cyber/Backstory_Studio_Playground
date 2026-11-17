import { readAgentMetadata } from '@/lib/agents/metadata'
import { parseAgentToolSettings } from '@/lib/connectors/tool-quick-config'
import { parseAgentHttpEndpoints } from '@/lib/integrations/http-endpoints'
import { DEFAULT_AGENT_MODEL } from '@/lib/llm/model-runner'

/** Stamped on the background agent made for an artifact that arrived without one. */
export const ARTIFACT_AGENT_TEMPLATE_ID = 'builtin:artifact-editor'

/**
 * Who may change an agent's visibility: its creator, or anyone who may edit a
 * legacy creatorless row. 'private' scopes an agent to `userId`
 * (agentVisibilityScope), so a non-creator editor choosing Private handed the
 * agent to its creator and lost it themselves.
 */
export function canChangeAgentVisibility(agent: { userId?: string | null }, viewerId: string): boolean {
  return !agent.userId || agent.userId === viewerId
}

/**
 * The wire shape for an agent, shared by /api/agents and /api/snapshot so the
 * two lists are always interchangeable on the client.
 *
 * `viewerId` (the caller's database user id) adds the facts that depend on who
 * is looking. Pass it explicitly — never as a bare `.map(serializeAgent)`,
 * which would hand the array index in its place.
 */
export function serializeAgent(agent: {
  id: string
  userId?: string | null
  artifactTemplateCopyId?: string | null
  agentType?: string | null
  description: string
  objective: string
  goal: string | null
  metadata: unknown
  folder: string | null
  teammateId: string | null
  visibility: string
  status: string
  priority: string
  schedule: unknown
  createdAt: Date
  lastExecutedAt: Date | null
  executionCount: number
}, viewerId?: string) {
  const metadata = readAgentMetadata(agent.metadata)
  return {
    id: agent.id,
    // 'external' = runs on someone else's infrastructure (inbound BYOA): no
    // platform tools, answers through the agent reply API. See
    // src/lib/agents/external/types.ts.
    agentType: (agent.agentType ?? 'CUSTOM').toUpperCase() === 'EXTERNAL' ? ('external' as const) : ('custom' as const),
    title: metadata.title || agent.description.split('\n')[0] || 'Untitled agent',
    description: metadata.description || agent.description,
    instructions: agent.objective,
    goal: agent.goal || null,
    model: metadata.model || DEFAULT_AGENT_MODEL,
    integrations: metadata.integrations || [],
    toolSettings: parseAgentToolSettings(metadata.toolSettings),
    skills: metadata.skills || [],
    icon: metadata.icon || '',
    roleLabel: metadata.roleLabel || null,
    avatarSeed: metadata.avatarSeed || null,
    allowSubagents: (metadata as { allowSubagents?: boolean }).allowSubagents === true,
    subagentIds: ((metadata as { subagentIds?: string[] }).subagentIds ?? []).filter((id) => typeof id === 'string'),
    allowFlows: (metadata as { allowFlows?: boolean }).allowFlows === true,
    httpEndpoints: parseAgentHttpEndpoints(metadata.httpEndpoints),
    flowIds: ((metadata as { flowIds?: string[] }).flowIds ?? []).filter((id) => typeof id === 'string'),
    autoAnswerFromMemory: metadata.autoAnswerFromMemory === true,
    alwaysStrategize: metadata.alwaysStrategize === true,
    requireApproval: metadata.requireApproval === true,
    suggestedGoal: metadata.suggestedGoal || null,
    folder: agent.folder || null,
    teammateId: agent.teammateId || null,
    visibility: agent.visibility || 'shared',
    // Made for one artifact (its editor, or a template copy's copilot) rather
    // than by a person: reachable from that artifact, kept out of agent lists.
    madeForArtifact: Boolean(agent.artifactTemplateCopyId) || (metadata as { templateId?: unknown }).templateId === ARTIFACT_AGENT_TEMPLATE_ID,
    // A personal template copy's copilot: listed so its run links resolve, but
    // operated only from inside its artifact — chat, run, configure and delete
    // all refuse it (configurableAgentScope). The id is the copy's artifact, so
    // its card can open that instead of an agent panel that cannot work.
    templateCopyArtifactId: agent.artifactTemplateCopyId ?? null,
    // Whether THIS viewer may change who sees the agent — the rule PUT enforces.
    ...(viewerId !== undefined ? { canChangeVisibility: canChangeAgentVisibility(agent, viewerId) } : {}),
    status: agent.status.toLowerCase(),
    priority: agent.priority.toLowerCase(),
    schedule: agent.schedule,
    createdAt: agent.createdAt,
    lastExecutedAt: agent.lastExecutedAt,
    executionCount: agent.executionCount,
  }
}

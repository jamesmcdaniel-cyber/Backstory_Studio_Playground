import type { Agent } from '@/lib/types'

/**
 * What the agents UI offers THIS viewer for one agent, from the facts the
 * server already decides with: the viewer's permissions (agent.write to
 * create/configure/save, agent.run to run/reply/chat, api.manage for an
 * external agent's delivery settings) and the agent's own kind.
 *
 * Cosmetic by design — every route re-checks — but an affordance the server
 * is certain to refuse is a dead end with a generic error, which is what a
 * member hit on Connect. So nothing here is offered that the route would deny.
 */
export type AgentViewerPermissions = { canWrite: boolean; canRun: boolean; canManageApi: boolean }

export function agentPermissions(can: (permission: string) => boolean): AgentViewerPermissions {
  return { canWrite: can('agent.write'), canRun: can('agent.run'), canManageApi: can('api.manage') }
}

export function agentActions(
  agent: Pick<Agent, 'agentType' | 'templateCopyArtifactId'>,
  permissions: AgentViewerPermissions,
): { openArtifactId: string | null; configure: boolean; run: boolean; chat: boolean } {
  // A personal template copy's copilot is operated from its artifact: every
  // agent route that runs or changes it refuses (configurableAgentScope), so
  // its card opens the artifact and offers nothing of its own.
  if (agent.templateCopyArtifactId) {
    return { openArtifactId: agent.templateCopyArtifactId, configure: false, run: false, chat: false }
  }
  return {
    openArtifactId: null,
    // An external agent's settings are delivery and credentials (api.manage);
    // everyone else's are the agent itself (agent.write).
    configure: agent.agentType === 'external' ? permissions.canManageApi : permissions.canWrite,
    run: permissions.canRun,
    chat: permissions.canRun,
  }
}

/** Why the assistant composer is closed for this agent, or null when it is open. */
export function chatBlockedReason(
  agent: Pick<Agent, 'agentType' | 'templateCopyArtifactId'> | null,
  permissions: AgentViewerPermissions,
): string | null {
  if (!agent) return null
  if (agent.templateCopyArtifactId) return 'This copilot works inside its artifact — open the artifact to chat with it.'
  if (!permissions.canRun) return 'Your workspace role can view agents but not message or run them — ask an admin to change your role.'
  return null
}

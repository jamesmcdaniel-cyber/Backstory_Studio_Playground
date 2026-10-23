/**
 * Inbound BYOA — an agent running on someone else's infrastructure, registered
 * as a teammate. Constants and wire shapes shared by the server and the UI.
 * Pure and client-safe.
 *
 *   register   → an AgentTask (agentType EXTERNAL) + ExternalAgent row +
 *                signing secret (shown once) + agents:reply API key
 *   dispatch   → the run parks in `waiting_for_external`; a signed webhook POST
 *                carries the task and a single-use reply token (outbox retries)
 *   reply      → POST /api/v1/agents/executions/[id]/reply settles the run
 *                through the normal completion path (Slack, flows, chat)
 *   timeout    → the dispatch tick fails a run whose agent never answered
 */

/** AgentTask.agentType for an external teammate. */
export const EXTERNAL_AGENT_TYPE = 'EXTERNAL'

/** AgentExecution.status while the task is with the external agent. */
export const WAITING_FOR_EXTERNAL = 'waiting_for_external'

/** The scope an external agent's API key carries — nothing else. */
export const AGENTS_REPLY_SCOPE = 'agents:reply'

/** Version stamped on every task body, so a receiver can branch on shape. */
export const EXTERNAL_TASK_API_VERSION = '2026-10-23'

/** Headers on every delivery. The signature algorithm is the audit stream's. */
export const EXTERNAL_SIGNATURE_HEADER = 'x-backstory-signature'
export const EXTERNAL_TIMESTAMP_HEADER = 'x-backstory-timestamp'
export const EXTERNAL_DELIVERY_HEADER = 'x-backstory-delivery'
export const EXTERNAL_EVENT_HEADER = 'x-backstory-event'
/** Where a reply may carry its token instead of the JSON body. */
export const EXTERNAL_REPLY_TOKEN_HEADER = 'x-backstory-reply-token'

/** Reply deadline bounds, in minutes. */
export const EXTERNAL_TIMEOUT_DEFAULT_MINUTES = 60
export const EXTERNAL_TIMEOUT_MIN_MINUTES = 1
export const EXTERNAL_TIMEOUT_MAX_MINUTES = 24 * 60

/** Delivery attempts before the run fails (the first one is immediate). */
export const EXTERNAL_DELIVERY_MAX_ATTEMPTS = 5

export function isExternalAgentType(agentType: string | null | undefined): boolean {
  return (agentType ?? '').toUpperCase() === EXTERNAL_AGENT_TYPE
}

/** What a settled external run carries until the runner finalizes it. */
export type ExternalReply = {
  status: 'completed' | 'failed'
  /** Markdown answer (completed) or the reason (failed). */
  output: string
  links: Array<{ title: string; url: string }>
  /** Who settled it: the agent itself, or the platform on its behalf. */
  source: 'agent' | 'timeout' | 'delivery' | 'removed'
  receivedAt: string
}

/** The task body POSTed to the webhook (see docs/external-agents.md). */
export type ExternalTaskPayload = {
  type: 'agent.task'
  apiVersion: string
  executionId: string
  agent: { id: string; name: string }
  task: { input: string; format: 'text/markdown' }
  context: {
    trigger: 'manual' | 'chat' | 'slack_mention' | 'slack_command' | 'flow' | 'schedule' | 'signal' | 'webhook' | 'other'
    requester: { displayName: string } | null
    slack: { channelId: string; threadTs: string } | null
    flow: { flowId: string; flowName: string | null; runId: string; stepId: string | null } | null
    chat: { sessionId: string } | null
  }
  scope: {
    platformTools: []
    summary: string
  }
  reply: {
    url: string
    progressUrl: string
    token: string
    expiresAt: string
  }
  sentAt: string
}

/** The scope summary every task states, verbatim. */
export const EXTERNAL_SCOPE_SUMMARY =
  'No platform tools. This agent sees only what this task contains and cannot read or act on any Backstory connection, account or document. Any future tool access would be an explicit grant by a workspace admin.'

/** One external agent as the management UI receives it. Never carries a secret. */
export type ExternalAgentView = {
  id: string
  agentId: string
  name: string
  webhookUrl: string
  webhookHost: string
  capabilities: string | null
  replyTimeoutMinutes: number
  enabled: boolean
  signingSecretRotatedAt: string | null
  apiKey: { id: string; clientId: string | null; expiresAt: string | null; revoked: boolean } | null
  lastDelivery: { at: string; status: 'delivered' | 'failed'; error: string | null } | null
  lastReplyAt: string | null
  createdAt: string
}

/** Returned once, at registration or rotation. */
export type ExternalAgentSecrets = {
  signingSecret?: string
  apiKey?: { clientId: string; clientSecret: string; tokenUrl: string; expiresAt: string }
}

export function webhookHostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

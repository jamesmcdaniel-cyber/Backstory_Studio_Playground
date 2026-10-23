/**
 * The task body an external agent receives — built once per execution, signed
 * per delivery attempt. Pure: everything it states comes from its arguments.
 *
 * What it carries is exactly what the agent may see, and nothing else: the
 * request, who asked (a display name, never an email or id), where it came
 * from (a Slack thread, a flow step, a chat), the scope statement, and the
 * single-use reply capability. No workspace data rides along implicitly.
 */

import {
  EXTERNAL_SCOPE_SUMMARY,
  EXTERNAL_TASK_API_VERSION,
  type ExternalTaskPayload,
} from './types'

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null)

/** Absolute app origin for the reply URLs (relative in a dev process without one). */
export function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/$/, '')
}

export function externalReplyUrls(executionId: string, base = appBaseUrl()) {
  const root = `${base}/api/v1/agents/executions/${encodeURIComponent(executionId)}`
  return { url: `${root}/reply`, progressUrl: `${root}/progress`, statusUrl: root }
}

/** Where a run came from, as the task's `context` states it. */
export function taskContextFromTrigger(trigger: unknown): Omit<ExternalTaskPayload['context'], 'requester'> {
  const record = asRecord(trigger)
  const type = str(record.type) ?? 'other'
  const empty = { slack: null, flow: null, chat: null }
  if (type === 'slack_mention' || type === 'slack_command') {
    const channelId = str(record.channelId)
    const threadTs = str(record.threadTs) ?? str(record.ts)
    return { ...empty, trigger: type, slack: channelId ? { channelId, threadTs: threadTs ?? '' } : null }
  }
  if (type === 'flow') {
    const flowId = str(record.flowId)
    const runId = str(record.flowRunId)
    return {
      ...empty,
      trigger: 'flow',
      flow: flowId && runId ? { flowId, flowName: str(record.flowName), runId, stepId: str(record.nodeId) } : null,
    }
  }
  if (type === 'manual' && record.source === 'assistant') {
    const sessionId = str(record.chatSessionId)
    return { ...empty, trigger: 'chat', chat: sessionId ? { sessionId } : null }
  }
  if (type === 'manual' || type === 'schedule' || type === 'signal' || type === 'webhook') return { ...empty, trigger: type }
  return { ...empty, trigger: 'other' }
}

export function buildExternalTaskPayload(params: {
  executionId: string
  agent: { id: string; name: string }
  input: string
  trigger: unknown
  requesterName: string | null
  replyToken: string
  replyExpiresAt: Date
  now?: Date
  baseUrl?: string
}): ExternalTaskPayload {
  const urls = externalReplyUrls(params.executionId, params.baseUrl)
  return {
    type: 'agent.task',
    apiVersion: EXTERNAL_TASK_API_VERSION,
    executionId: params.executionId,
    agent: params.agent,
    task: { input: params.input, format: 'text/markdown' },
    context: {
      ...taskContextFromTrigger(params.trigger),
      requester: params.requesterName ? { displayName: params.requesterName } : null,
    },
    scope: { platformTools: [], summary: EXTERNAL_SCOPE_SUMMARY },
    reply: {
      url: urls.url,
      progressUrl: urls.progressUrl,
      token: params.replyToken,
      expiresAt: params.replyExpiresAt.toISOString(),
    },
    sentAt: (params.now ?? new Date()).toISOString(),
  }
}

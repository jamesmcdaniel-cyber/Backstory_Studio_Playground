/**
 * Posting as a teammate.
 *
 * The reply is the APP speaking as itself, wearing the teammate's name and
 * face — not the asking human. That is why it uses the workspace bot token and
 * why it needs chat:write.customize; a roster of teammates that all post as one
 * generic bot is the thing this feature exists to avoid.
 */

import { getSlackToken } from '@/lib/integrations/slack'
import { apiLogger } from '@/lib/logger'

const POST_URL = 'https://slack.com/api/chat.postMessage'
const UPDATE_URL = 'https://slack.com/api/chat.update'

/**
 * Chain-depth stamp, matching applySlackChainDepthMetadata in
 * src/features/flows/tool-args.ts. The receiver reads it straight back out via
 * chainDepthFromMetadata, which is what lets ACTIVITY_CHAIN_DEPTH_CAP stop an
 * agent answering its own reply forever.
 */
const chainMetadata = (chainDepth: number) => ({
  event_type: 'flow_message',
  event_payload: { chainDepth },
})

async function slackPost(url: string, token: string, body: Record<string, unknown>) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  // Slack always returns HTTP 200; the body's `ok` is the real result.
  return (await response.json()) as Record<string, unknown>
}

export async function postTeammateMessage(params: {
  organizationId: string
  channelId: string
  threadTs: string
  text: string
  teammateName: string
  avatarUrl?: string | null
  chainDepth: number
}): Promise<{ ts: string } | null> {
  const token = await getSlackToken(params.organizationId)
  if (!token) return null
  const body = await slackPost(POST_URL, token.value, {
    channel: params.channelId,
    thread_ts: params.threadTs,
    text: params.text,
    username: params.teammateName,
    ...(params.avatarUrl ? { icon_url: params.avatarUrl } : {}),
    metadata: chainMetadata(params.chainDepth),
  })
  if (body.ok !== true || typeof body.ts !== 'string') {
    apiLogger.warn('slack teammate post failed', { organizationId: params.organizationId, error: body.error })
    return null
  }
  return { ts: body.ts }
}

export async function updateTeammateMessage(params: {
  organizationId: string
  channelId: string
  ts: string
  text: string
}): Promise<boolean> {
  const token = await getSlackToken(params.organizationId)
  if (!token) return false
  const body = await slackPost(UPDATE_URL, token.value, {
    channel: params.channelId,
    ts: params.ts,
    text: params.text,
  })
  if (body.ok !== true) {
    apiLogger.warn('slack teammate update failed', { organizationId: params.organizationId, error: body.error })
    return false
  }
  return true
}

/**
 * Resolve a mention's placeholder with the run's outcome.
 *
 * Called from the run's COMPLETION path rather than the dispatcher: in queue
 * mode dispatchAgentExecution returns as soon as the job is enqueued, long
 * before there is anything to say. The Slack context travels on the execution's
 * `trigger`, which is already persisted, so the queue payload needs nothing
 * extra.
 *
 * Failures update the same placeholder rather than going silent — a mention
 * that never gets answered is indistinguishable from the app being broken.
 */
export async function finishSlackMention(params: {
  organizationId: string
  trigger: unknown
  text: string
  teammateName?: string
}): Promise<void> {
  const trigger = (params.trigger && typeof params.trigger === 'object' ? params.trigger : {}) as Record<string, unknown>
  if (trigger.type !== 'slack_mention') return

  const channelId = typeof trigger.channelId === 'string' ? trigger.channelId : ''
  const threadTs = typeof trigger.threadTs === 'string' ? trigger.threadTs : ''
  const placeholderTs = typeof trigger.placeholderTs === 'string' ? trigger.placeholderTs : ''
  const chainDepth = typeof trigger.chainDepth === 'number' ? trigger.chainDepth : 1
  const teammateName =
    params.teammateName || (typeof trigger.teammateName === 'string' ? trigger.teammateName : 'Backstory')
  if (!channelId) return

  // Slack hard-caps a message body; a long answer is truncated with a pointer
  // rather than silently rejected by the API.
  const text =
    params.text.length > 3800
      ? `${params.text.slice(0, 3800)}\n\n_(truncated — open the run in Backstory for the rest)_`
      : params.text || '_(the run produced no output)_'

  if (placeholderTs) {
    const updated = await updateTeammateMessage({
      organizationId: params.organizationId,
      channelId,
      ts: placeholderTs,
      text,
    })
    if (updated) return
    // Fall through: the placeholder may have been deleted. A new message beats
    // no answer.
  }
  if (!threadTs) return
  await postTeammateMessage({
    organizationId: params.organizationId,
    channelId,
    threadTs,
    text,
    teammateName,
    chainDepth,
  })
}

/**
 * Record the agent's answer as the assistant turn of the thread's conversation,
 * so the next follow-up in that thread can see it.
 */
export async function recordSlackAnswer(params: {
  organizationId: string
  trigger: unknown
  agentTaskId: string
  userId: string
  text: string
}): Promise<void> {
  const trigger = (params.trigger && typeof params.trigger === 'object' ? params.trigger : {}) as Record<string, unknown>
  if (trigger.type !== 'slack_mention') return
  const sessionId = typeof trigger.sessionId === 'string' ? trigger.sessionId : ''
  if (!sessionId || !params.text) return
  const { recordThreadTurn } = await import('@/lib/slack/thread-session')
  await recordThreadTurn({
    organizationId: params.organizationId,
    agentTaskId: params.agentTaskId,
    userId: params.userId,
    sessionId,
    role: 'assistant',
    content: params.text,
  })
}

/**
 * Terminal-path entry point: resolve a run's Slack thread from the execution
 * row itself.
 *
 * Reads the trigger here rather than taking it as an argument so the agent
 * runtime's call sites stay one-liners and do not depend on which local
 * variable happens to hold the row at that point.
 */
export async function finishSlackMentionForExecution(executionId: string, text: string): Promise<void> {
  const { systemPrisma } = await import('@/lib/prisma')
  const execution = await systemPrisma.agentExecution.findUnique({
    where: { id: executionId },
    select: { organizationId: true, trigger: true, agentTaskId: true, userId: true },
  })
  if (!execution) return
  const trigger = execution.trigger as Record<string, unknown> | null
  if (!trigger || trigger.type !== 'slack_mention') return

  await finishSlackMention({ organizationId: execution.organizationId, trigger, text })
  if (execution.agentTaskId) {
    await recordSlackAnswer({
      organizationId: execution.organizationId,
      trigger,
      agentTaskId: execution.agentTaskId,
      userId: execution.userId,
      text,
    })
  }
}

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
  /**
   * Omitted for a top-level post. A slash command has no thread to reply into,
   * and sending an empty thread_ts is rejected by Slack rather than ignored.
   */
  threadTs?: string
  text: string
  teammateName: string
  avatarUrl?: string | null
  chainDepth: number
}): Promise<{ ts: string } | null> {
  const token = await getSlackToken(params.organizationId)
  if (!token) return null
  const body = await slackPost(POST_URL, token.value, {
    channel: params.channelId,
    ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
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
 * Reply to a slash command through its own `response_url`.
 *
 * Not a channel post. A command can be invoked in a channel the bot was never
 * invited to, where chat.postMessage fails with not_in_channel — and a
 * `/dealcheck` that silently answers nowhere is worse than one that refuses.
 * `response_url` needs no membership and no token: possession of the URL,
 * which only Slack ever sends us, IS the authorization.
 *
 * The trade is its lifetime: a URL is good for 30 minutes and 5 uses. That is
 * the same order as AGENT_RUN_MAX_DURATION_SECONDS, so a run that uses its full
 * budget can outlive its own reply channel. `finishSlackCommand` handles that
 * case rather than pretending it cannot happen.
 */
export async function postCommandResponse(params: {
  responseUrl: string
  text: string
  /** `in_channel` shows the answer to everyone; `ephemeral` only to the caller. */
  visibility: 'in_channel' | 'ephemeral'
}): Promise<boolean> {
  try {
    const response = await fetch(params.responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ response_type: params.visibility, text: params.text }),
      signal: AbortSignal.timeout(15_000),
    })
    // Unlike the Web API, a response_url reports failure through the HTTP
    // status — an expired URL is a 4xx, not a 200 with ok:false.
    if (!response.ok) {
      apiLogger.warn('slack command response rejected', { status: response.status })
      return false
    }
    return true
  } catch (error) {
    apiLogger.warn('slack command response failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/**
 * Deliver a slash-command run's answer.
 *
 * Falls back to a channel post when the response_url is spent or expired — the
 * run took longer than Slack's 30-minute window, or Slack rejected the write.
 * The fallback needs the bot to be in the channel and may itself fail; that is
 * still strictly better than dropping a finished answer on the floor.
 */
export async function finishSlackCommand(params: {
  organizationId: string
  trigger: unknown
  text: string
}): Promise<void> {
  const trigger = (params.trigger && typeof params.trigger === 'object' ? params.trigger : {}) as Record<string, unknown>
  if (trigger.type !== 'slack_command') return

  const responseUrl = typeof trigger.responseUrl === 'string' ? trigger.responseUrl : ''
  const channelId = typeof trigger.channelId === 'string' ? trigger.channelId : ''
  const teammateName = typeof trigger.teammateName === 'string' ? trigger.teammateName : 'Backstory'

  const text =
    params.text.length > 3800
      ? `${params.text.slice(0, 3800)}\n\n_(truncated — open the run in Backstory for the rest)_`
      : params.text || '_(the run produced no output)_'

  // in_channel: a slash command's answer is normally useful to the channel it
  // was asked in — that is the difference between a shared deal inspection and
  // a private one. The ACK is ephemeral; the ANSWER is not.
  if (responseUrl && (await postCommandResponse({ responseUrl, text, visibility: 'in_channel' }))) return

  if (!channelId) return
  await postTeammateMessage({
    organizationId: params.organizationId,
    channelId,
    text,
    teammateName,
    chainDepth: 1,
  }).catch(() => undefined)
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
  if (!trigger) return

  // A slash command answers through its own response_url and keeps no thread
  // conversation, so it returns here rather than falling through to the
  // mention path's thread bookkeeping.
  if (trigger.type === 'slack_command') {
    await finishSlackCommand({ organizationId: execution.organizationId, trigger, text })
    return
  }
  if (trigger.type !== 'slack_mention') return

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

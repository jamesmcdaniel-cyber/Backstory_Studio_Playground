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

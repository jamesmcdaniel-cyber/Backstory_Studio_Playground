/**
 * Slack REST API integration
 *
 * Exposes one agent tool — post_message — that lets agents post messages to a
 * Slack channel during a run.
 *
 * Token resolution (per organization, see org-credential.ts):
 *  1. The workspace's own bot token from integration_secrets (provider 'slack').
 *  2. SLACK_BOT_TOKEN from the environment — reachable ONLY by internal/partner
 *     workspaces. A customer org without its own token does not get the tool.
 *
 * This used to read SLACK_BOT_TOKEN unconditionally, which meant every
 * workspace's agents posted into one Slack workspace with one bot identity —
 * org A's agent could read and write org B's channels.
 *
 * All env vars are read at call time (never at module load) so that the
 * Next.js build succeeds even when they are not set.
 */

import type { ToolDefinition } from '@/lib/llm/model-runner'
import { resolveOrgCredential, type ResolvedCredential } from './org-credential'

const SLACK_API_URL = 'https://slack.com/api/chat.postMessage'

export const SLACK_PROVIDER = 'slack'

// ---------------------------------------------------------------------------
// Per-org token resolution
// ---------------------------------------------------------------------------

export async function getSlackToken(organizationId: string): Promise<ResolvedCredential | null> {
  return resolveOrgCredential({
    organizationId,
    provider: SLACK_PROVIDER,
    envValue: process.env.SLACK_BOT_TOKEN,
  })
}

export async function slackConfigured(organizationId: string): Promise<boolean> {
  return Boolean(await getSlackToken(organizationId))
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export function slackTools(): ToolDefinition[] {
  return [
    {
      name: 'post_message',
      description:
        'Post a message to a Slack channel. `channel` is a channel id or name (e.g. "#revenue" or "C012AB3CD"); `text` supports Slack mrkdwn.',
      inputSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['channel', 'text'],
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// SlackToolClient
// ---------------------------------------------------------------------------

export class SlackToolClient {
  // The resolved per-org token is injected at construction (see getSlackToken),
  // exactly like GranolaToolClient, so tool execution never reads global state —
  // which is what made the token workspace-agnostic in the first place.
  constructor(private readonly token: string) {}

  // Satisfies the McpToolClient interface in execute-agent.ts:
  //   executeTool(serverUrl, name, args): Promise<any>
  // Returns the parsed JSON object directly — the same shape as
  // GranolaToolClient.executeTool, so the run loop's JSON.stringify(result)
  // wrapping is identical for all integrations.
  async executeTool(
    _serverUrl: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const token = this.token
    if (!token) throw new Error('Slack bot token is not configured')

    if (name === 'post_message') {
      const response = await fetch(SLACK_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          channel: args.channel,
          text: args.text,
        }),
        signal: AbortSignal.timeout(30_000),
      })

      // Slack always returns HTTP 200 even on failure; we must inspect body.ok
      const body = (await response.json()) as Record<string, unknown>
      if (body.ok !== true) {
        throw new Error(`Slack API error: ${body.error ?? 'unknown'}`)
      }

      return body
    }

    throw new Error(`Unknown Slack tool: ${name}`)
  }
}

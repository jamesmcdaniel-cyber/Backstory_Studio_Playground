/**
 * A slash command becomes a run.
 *
 * Mirrors dispatchSlackMention's rulings deliberately, because the exposure is
 * the same: anyone who can type in the workspace can invoke this, so a run must
 * belong to the person who typed it and no one else. An unlinked Slack user
 * starts nothing, spends nothing, and is told how to link.
 *
 * What differs from a mention is only delivery. A command has no thread, and
 * the invoking channel may be one the bot was never invited to — so the answer
 * goes back through the command's own `response_url`, which needs no channel
 * membership. See finishSlackCommand in reply.ts.
 */

import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import type { SlackCommandPayload } from '@/lib/slack/command'
import { postCommandResponse } from '@/lib/slack/reply'

export type CommandOutcome =
  | { outcome: 'ran'; executionId: string; agentName: string }
  | { outcome: 'unlinked' }
  | { outcome: 'unbound' }
  | { outcome: 'duplicate' }
  | { outcome: 'failed'; reason: string }

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

function linkPrompt(): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '')
  const where = base ? `${base}/integrations?connect=slack` : 'Backstory → Integrations'
  return (
    `Connect your Slack account first and I can run this for you: ${where}\n\n` +
    'I run as you, with your access — so I need to know who you are before I act on your behalf.'
  )
}

/**
 * Start the run behind a verified command.
 *
 * Called AFTER the route has already acked Slack, so nothing here is on the
 * 3-second budget and every failure reports itself through `response_url`
 * rather than an HTTP status nobody sees.
 */
export async function dispatchSlackCommand(params: {
  organizationId: string
  payload: SlackCommandPayload
  /** Slack's own id for this invocation, used as the replay guard. */
  invocationId: string
}): Promise<CommandOutcome> {
  const { organizationId, payload } = params

  const respond = (text: string) =>
    postCommandResponse({ responseUrl: payload.responseUrl, text, visibility: 'ephemeral' }).catch(() => undefined)

  // Fail closed, exactly as mentions do. Guessing which human this is would
  // spend their run allowance and expose their data to anyone in the workspace.
  const identity = await systemPrisma.slackIdentity.findUnique({
    where: { organizationId_slackUserId: { organizationId, slackUserId: payload.slackUserId } },
    select: { userId: true },
  })
  if (!identity) {
    await respond(linkPrompt())
    return { outcome: 'unlinked' }
  }

  const binding = await systemPrisma.slackCommandBinding.findUnique({
    where: { organizationId_command: { organizationId, command: payload.command } },
    select: { agentTaskId: true },
  })
  if (!binding) {
    await respond(
      `No teammate is set up to answer /${payload.command} in this workspace yet. ` +
        'An admin can bind it to an agent in Backstory under Integrations → Slack.',
    )
    return { outcome: 'unbound' }
  }

  const agent = await systemPrisma.agentTask.findFirst({
    where: { id: binding.agentTaskId, organizationId, status: { not: 'DELETED' } },
    select: { id: true, description: true, metadata: true },
  })
  if (!agent) {
    // The cascade covers a deleted row; this covers one that was soft-deleted,
    // which leaves the binding intact and pointing at something unrunnable.
    await respond(`The teammate bound to /${payload.command} is no longer available. An admin can re-bind it.`)
    return { outcome: 'unbound' }
  }
  const agentName = String(asRecord(agent.metadata).title ?? agent.description ?? 'Backstory').trim() || 'Backstory'

  // Exactly-once on the same mechanism mentions use: AgentExecution's unique
  // idempotency key. Slack retries a command whose ack it did not see, and a
  // retried /dealcheck must not start a second billed run.
  const idempotencyKey = `slash:${params.invocationId}`
  const existing = await systemPrisma.agentExecution.findUnique({
    where: { organizationId_idempotencyKey: { organizationId, idempotencyKey } },
    select: { id: true },
  })
  if (existing) return { outcome: 'duplicate' }

  const prompt = payload.text || `Run your standard ${agentName} check and report the result.`

  let execution
  try {
    execution = await systemPrisma.agentExecution.create({
      data: {
        agentType: 'CUSTOM',
        agentTaskId: agent.id,
        status: 'pending',
        input: { prompt },
        idempotencyKey,
        trigger: {
          type: 'slack_command',
          command: payload.command,
          responseUrl: payload.responseUrl,
          channelId: payload.channelId,
          slackUserId: payload.slackUserId,
          teammateName: agentName,
        },
        userId: identity.userId,
        organizationId,
      },
    })
  } catch {
    // A concurrent retry won the unique key. That is the guard working.
    return { outcome: 'duplicate' }
  }

  const executionId = execution.id
  const { dispatchAgentExecution } = await import('@/features/agents/dispatch')
  // NOT awaited: in inline mode awaiting would run the whole agent here, long
  // after Slack stopped listening. A start that fails must still say so, or the
  // person is left with an ack and silence.
  void dispatchAgentExecution({
    executionId,
    agentId: agent.id,
    organizationId,
    userId: identity.userId,
    input: prompt,
  }).catch(async (error) => {
    const detail = error instanceof Error ? error.message : String(error)
    apiLogger.error('slack command run failed to start', { executionId, error: detail })
    await systemPrisma.agentExecution
      .updateMany({
        where: { id: executionId, organizationId, status: 'pending' },
        data: { status: 'failed', error: detail.slice(0, 300), completedAt: new Date() },
      })
      .catch(() => undefined)
    await respond('That run could not be started. Try again in a moment.')
  })

  return { outcome: 'ran', executionId, agentName }
}

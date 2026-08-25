/**
 * A mention becomes a run.
 *
 * Deliberately NOT dispatchActivityEvent: that path is flow-only and attributes
 * runs to `flow.userId` or the oldest active user in the org. That attribution
 * is defensible for a flow trigger its owner configured, and is exactly the
 * hole this design rejects for mentions — anyone who can see the channel would
 * otherwise borrow someone else's data access.
 */

import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { ACTIVITY_CHAIN_DEPTH_CAP } from '@/lib/activity/dispatch'
import { resolveMention, type MentionAgent } from '@/lib/slack/mention'
import { postTeammateMessage, updateTeammateMessage } from '@/lib/slack/reply'

type Outcome = { outcome: 'ran' | 'unlinked' | 'asked' | 'skipped'; reason?: string }

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

export async function dispatchSlackMention(activityEventId: string): Promise<Outcome> {
  const event = await systemPrisma.activityEvent.findUnique({ where: { id: activityEventId } })
  if (!event || event.kind !== 'agent.mentioned') return { outcome: 'skipped', reason: 'not-a-mention' }

  // The agent's own reply lands back in this channel as another event. Both
  // guards are what stop it answering itself forever.
  if (event.selfOrigin) return { outcome: 'skipped', reason: 'self-origin' }
  if (event.chainDepth >= ACTIVITY_CHAIN_DEPTH_CAP) return { outcome: 'skipped', reason: 'depth-capped' }

  const subject = asRecord(event.subject)
  const channelId = typeof subject.channelId === 'string' ? subject.channelId : ''
  // Slack sets thread_ts only on a REPLY, so a top-level mention — the common
  // case — has none. Threading against the message's own ts is what starts the
  // thread, the same fallback applySlackThreadDefault uses for flows.
  const threadTs =
    (typeof subject.threadTs === 'string' && subject.threadTs) ||
    (typeof subject.ts === 'string' ? subject.ts : '')
  if (!channelId || !threadTs) return { outcome: 'skipped', reason: 'no-thread' }

  const inner = asRecord(asRecord(event.payload).event)
  const text = typeof inner.text === 'string' ? inner.text : ''

  const credential = await systemPrisma.integrationSecret.findUnique({
    where: { organizationId_provider: { organizationId: event.organizationId, provider: 'slack' } },
    select: { authConfig: true },
  })
  const botUserId = String(asRecord(credential?.authConfig).botUserId ?? '')
  if (!botUserId) return { outcome: 'skipped', reason: 'no-bot-identity' }

  const reply = (body: string, name = 'Backstory') =>
    postTeammateMessage({
      organizationId: event.organizationId,
      channelId,
      threadTs,
      text: body,
      teammateName: name,
      chainDepth: event.chainDepth + 1,
    })

  // Fail closed. Guessing which human this is would spend their run allowance
  // and expose their data to anyone who can see the channel.
  const identity = event.actorExternalId
    ? await systemPrisma.slackIdentity.findUnique({
        where: {
          organizationId_slackUserId: {
            organizationId: event.organizationId,
            slackUserId: event.actorExternalId,
          },
        },
        select: { userId: true },
      })
    : null
  if (!identity) {
    await reply(
      'Connect your Slack account in Backstory first — I run as you, with your access, so I need to know who you are before I can help here.',
    )
    return { outcome: 'unlinked' }
  }

  const agents = await systemPrisma.agentTask.findMany({
    where: { organizationId: event.organizationId, status: { not: 'DELETED' } },
    select: { id: true, description: true, metadata: true },
    take: 300,
  })
  const roster: MentionAgent[] = agents.map((agent) => {
    const metadata = asRecord(agent.metadata)
    return {
      id: agent.id,
      name: String(metadata.title ?? agent.description ?? '').trim(),
      roleLabel: typeof metadata.roleLabel === 'string' ? metadata.roleLabel : null,
    }
  })

  const binding = await systemPrisma.slackChannelBinding.findUnique({
    where: { organizationId_channelId: { organizationId: event.organizationId, channelId } },
    select: { agentTaskId: true },
  })

  const resolution = resolveMention({ text, botUserId, agents: roster, boundAgentId: binding?.agentTaskId })
  if (resolution.kind === 'none') {
    await reply('There are no agents in this workspace yet.')
    return { outcome: 'asked', reason: 'empty-roster' }
  }
  if (resolution.kind === 'ask') {
    const names = resolution.candidates.slice(0, 8).map((agent) => agent.name).filter(Boolean)
    await reply(`Which teammate should take this? ${names.join(', ')}`)
    return { outcome: 'asked', reason: resolution.reason }
  }

  // Exactly-once without a third claim table: AgentExecution.idempotencyKey is
  // unique per org and already exists as the replay guard for signal-triggered
  // runs. A redelivered mention collides and is a no-op.
  const idempotencyKey = `mention:${event.id}:${resolution.agent.id}`
  const existing = await systemPrisma.agentExecution.findUnique({
    where: { organizationId_idempotencyKey: { organizationId: event.organizationId, idempotencyKey } },
    select: { id: true },
  })
  if (existing) return { outcome: 'skipped', reason: 'already-dispatched' }

  // A Slack thread is a conversation: continue it, so a follow-up knows what it
  // is following up on.
  const { threadSession, recordThreadTurn, withThreadContext } = await import('@/lib/slack/thread-session')
  const session = await threadSession({
    organizationId: event.organizationId,
    agentTaskId: resolution.agent.id,
    userId: identity.userId,
    channelId,
    threadTs,
  })
  const prompt = withThreadContext(resolution.prompt, session.priorTurns)
  await recordThreadTurn({
    organizationId: event.organizationId,
    agentTaskId: resolution.agent.id,
    userId: identity.userId,
    sessionId: session.id,
    role: 'user',
    content: resolution.prompt,
  })

  const placeholder = await reply(`_${resolution.agent.name} is on it…_`, resolution.agent.name)

  let execution
  try {
    execution = await systemPrisma.agentExecution.create({
      data: {
        agentType: 'CUSTOM',
        agentTaskId: resolution.agent.id,
        status: 'pending',
        input: { prompt },
        idempotencyKey,
        trigger: {
          type: 'slack_mention',
          channelId,
          threadTs,
          slackUserId: event.actorExternalId,
          activityEventId: event.id,
          chainDepth: event.chainDepth + 1,
          sessionId: session.id,
          teammateName: resolution.agent.name,
          ...(placeholder ? { placeholderTs: placeholder.ts } : {}),
        },
        userId: identity.userId,
        organizationId: event.organizationId,
      },
    })
  } catch {
    // A concurrent delivery won the unique key. That is the guard working.
    apiLogger.info('slack mention already dispatched', { activityEventId: event.id })
    return { outcome: 'skipped', reason: 'race-lost' }
  }

  // NOT awaited. This function's contract is "the run is started", not "the run
  // finished" — the answer comes from the run's own completion path. Awaiting
  // would also mean inline mode runs the entire agent inside this call.
  //
  // A start that fails must not leave a `pending` row and a placeholder saying
  // "on it…" forever, so the failure is caught, recorded, and shown.
  const executionId = execution.id
  const { dispatchAgentExecution } = await import('@/features/agents/dispatch')
  void dispatchAgentExecution({
    executionId,
    agentId: resolution.agent.id,
    organizationId: event.organizationId,
    userId: identity.userId,
    input: prompt,
  }).catch(async (error) => {
    const detail = error instanceof Error ? error.message : String(error)
    apiLogger.error('slack mention run failed to start', { executionId, error: detail })
    await systemPrisma.agentExecution
      .updateMany({
        where: { id: executionId, organizationId: event.organizationId, status: 'pending' },
        data: { status: 'failed', error: detail.slice(0, 300), completedAt: new Date() },
      })
      .catch(() => undefined)
    if (placeholder) {
      await updateTeammateMessage({
        organizationId: event.organizationId,
        channelId,
        ts: placeholder.ts,
        text: 'That run could not be started. Try again in a moment.',
      }).catch(() => undefined)
    }
  })

  return { outcome: 'ran' }
}

/**
 * A Slack thread IS a conversation, so it maps to one AgentChatSession.
 *
 * Without this every follow-up in a thread would start from nothing — "and what
 * about last quarter?" would arrive with no idea what "that" was, which is the
 * difference between a teammate and a stateless command line.
 */

import { systemPrisma } from '@/lib/prisma'

/**
 * How many prior turns to replay. Enough for context, bounded so a long-running
 * thread cannot grow the prompt without limit.
 */
const WINDOW = 10

export async function threadSession(params: {
  organizationId: string
  agentTaskId: string
  userId: string
  channelId: string
  threadTs: string
}): Promise<{ id: string; priorTurns: Array<{ role: string; content: string }> }> {
  const existing = await systemPrisma.agentChatSession.findUnique({
    where: { slackChannelId_slackThreadTs: { slackChannelId: params.channelId, slackThreadTs: params.threadTs } },
    select: { id: true },
  })

  // A thread already owned by a DIFFERENT teammate keeps its owner: someone
  // naming another teammate mid-thread gets that teammate for the run, but the
  // shared history stays where it is rather than being silently re-parented.
  if (existing) {
    const recent = await systemPrisma.agentChatMessage.findMany({
      where: { sessionId: existing.id },
      orderBy: { createdAt: 'desc' },
      take: WINDOW,
      select: { role: true, content: true },
    })
    return { id: existing.id, priorTurns: recent.reverse() }
  }

  const created = await systemPrisma.agentChatSession.create({
    data: {
      organizationId: params.organizationId,
      agentTaskId: params.agentTaskId,
      userId: params.userId,
      slackChannelId: params.channelId,
      slackThreadTs: params.threadTs,
    },
    select: { id: true },
  })
  return { id: created.id, priorTurns: [] }
}

export async function recordThreadTurn(params: {
  organizationId: string
  agentTaskId: string
  userId: string
  sessionId: string
  role: 'user' | 'assistant'
  content: string
}): Promise<void> {
  await systemPrisma.agentChatMessage.create({
    data: {
      organizationId: params.organizationId,
      agentTaskId: params.agentTaskId,
      userId: params.userId,
      sessionId: params.sessionId,
      role: params.role,
      content: params.content,
    },
  })
}

/** Prepend prior turns so a follow-up knows what it is following up on. */
export function withThreadContext(
  prompt: string,
  priorTurns: Array<{ role: string; content: string }>,
): string {
  if (priorTurns.length === 0) return prompt
  const transcript = priorTurns
    .map((turn) => `${turn.role === 'assistant' ? 'You' : 'They'}: ${turn.content}`)
    .join('\n')
  return `Earlier in this Slack thread:\n${transcript}\n\nNow they ask: ${prompt}`
}

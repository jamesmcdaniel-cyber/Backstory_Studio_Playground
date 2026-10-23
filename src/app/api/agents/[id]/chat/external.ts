import type { AgentChatMessage, AgentTask } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { ApiError } from '@/lib/server/api-handler'
import type { AuthContext } from '@/lib/server/auth'
import { rateLimit } from '@/lib/ratelimit'
import { checkDailyRunAllowance, limitMessage } from '@/lib/usage/free-tier-limits'
import { dispatchAgentExecution } from '@/features/agents/dispatch'
import { EXECUTION_BACKEND_OFFLINE_MESSAGE } from '@/lib/queue/heartbeat'
import { deriveTitle, LEGACY_SESSION_ID } from './shared'

/**
 * The Assistant chat for an EXTERNAL agent. There is no assistant model in
 * between: the message IS the task. It goes to the agent as one run (counted
 * like any agent run against the daily allowance), and the agent's reply is
 * posted into this same thread by the run's completion path when it arrives —
 * seconds or an hour later.
 *
 * Both messages are written BEFORE the run starts, so a fast agent's answer
 * always lands after the question that asked for it.
 */
export async function respondToExternalAgentChat(params: {
  agent: AgentTask
  auth: AuthContext
  message: string
  requestedSessionId?: string
  serialize: (message: AgentChatMessage) => unknown
}) {
  const { agent, auth, message } = params
  const name = ((agent.metadata as { title?: string } | null)?.title || agent.description).trim()
  if (agent.status !== 'ACTIVE') throw new ApiError(`${name} is paused. Resume it before sending it work.`, 409, 'AGENT_PAUSED')

  const limited = await rateLimit(`agent-run:${auth.organizationId}`, { limit: 30, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Too many agent runs started in the last minute — wait a moment and ask again.', 429, 'RATE_LIMITED')
  const allowance = await checkDailyRunAllowance('agent', {
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    canReview: auth.can('catalogue.review'),
    email: auth.dbUser.email,
  })
  if (allowance.over) throw new ApiError(limitMessage('agent', allowance.limit), 429, 'DAILY_LIMIT_REACHED')

  let session =
    params.requestedSessionId && params.requestedSessionId !== LEGACY_SESSION_ID
      ? await prisma.agentChatSession.findFirst({
          where: { id: params.requestedSessionId, organizationId: auth.organizationId, agentTaskId: agent.id, userId: auth.dbUser.id },
        })
      : null
  if (!session) {
    session = await prisma.agentChatSession.create({
      data: { agentTaskId: agent.id, organizationId: auth.organizationId, userId: auth.dbUser.id, title: deriveTitle(message) },
    })
  }

  const execution = await prisma.agentExecution.create({
    data: {
      agentType: agent.agentType,
      agentTaskId: agent.id,
      status: 'pending',
      input: { prompt: message },
      trigger: { type: 'manual', source: 'assistant', chatSessionId: session.id },
      metadata: { title: name },
      userId: auth.dbUser.id,
      organizationId: auth.organizationId,
    },
  })
  const userMessage = await prisma.agentChatMessage.create({
    data: { agentTaskId: agent.id, organizationId: auth.organizationId, userId: auth.dbUser.id, sessionId: session.id, role: 'user', content: message },
  })
  const run = { task: message.slice(0, 500), executionId: execution.id, status: 'waiting_for_external' }
  const assistantMessage = await prisma.agentChatMessage.create({
    data: {
      agentTaskId: agent.id,
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      sessionId: session.id,
      role: 'assistant',
      content: `Sent to ${name}. It runs outside Backstory and sees only this message; its reply will appear here.`,
      metadata: { run },
    },
  })
  await prisma.agentChatSession.update({ where: { id: session.id, organizationId: auth.organizationId }, data: { title: session.title ?? deriveTitle(message) } }).catch(() => undefined)

  try {
    await dispatchAgentExecution({ executionId: execution.id, agentId: agent.id, organizationId: auth.organizationId, userId: auth.dbUser.id, input: message })
  } catch (error) {
    // The runner posts its own failures into this thread once it has the run;
    // this covers a run that never started (queue offline, worker disabled).
    const detail = error instanceof Error ? error.message : String(error)
    const stillPending = await prisma.agentExecution.updateMany({
      where: { id: execution.id, organizationId: auth.organizationId, status: 'pending' },
      data: { status: 'failed', error: detail.slice(0, 300), completedAt: new Date() },
    })
    if (stillPending.count) {
      await prisma.agentChatMessage.create({
        data: {
          agentTaskId: agent.id,
          organizationId: auth.organizationId,
          userId: auth.dbUser.id,
          sessionId: session.id,
          role: 'assistant',
          content: detail === EXECUTION_BACKEND_OFFLINE_MESSAGE ? detail : `The task could not be sent: ${detail}`,
          metadata: { run: { ...run, status: 'failed' } },
        },
      })
    }
  }
  return { success: true, sessionId: session.id, messages: [params.serialize(userMessage), params.serialize(assistantMessage)] }
}

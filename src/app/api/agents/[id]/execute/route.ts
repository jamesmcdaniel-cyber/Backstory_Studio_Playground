import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { createQueue, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { runAgentExecution } from '@/features/agents/execute-agent'
import { inlineExecution } from '@/lib/queue/execution-mode'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { rateLimit } from '@/lib/ratelimit'

export const runtime = 'nodejs'
export const maxDuration = 800

export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Agent id is required')
  // Cap manual runs per workspace: each run burns tokens on up to a 20-min
  // budget, and nothing else bounds how many a user (or a loop) can start.
  const limited = await rateLimit(`agent-run:${auth.organizationId}`, { limit: 30, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Too many agent runs — please wait a moment.', 429, 'RATE_LIMITED')
  const { input } = z.object({ input: z.string().optional() }).parse(await request.json())
  const agent = await prisma.agentTask.findFirst({
    where: {
      id,
      organizationId: auth.organizationId,
      status: 'ACTIVE',
      // Private agents are runnable only by their owner.
      ...agentVisibilityScope(auth.dbUser.id),
    },
  })
  if (!agent) throw new ApiError('Agent not found', 404, 'NOT_FOUND')

  // Skills are composed into the system prompt inside runAgentExecution, shared
  // by every trigger — pass the raw objective so they aren't applied twice.
  const runInput = input?.trim() || agent.objective

  const execution = await prisma.agentExecution.create({
    data: {
      agentType: agent.agentType,
      agentTaskId: agent.id,
      status: 'pending',
      input: { prompt: runInput },
      trigger: { type: 'manual' },
      metadata: { title: (agent.metadata as any)?.title || agent.description },
      userId: auth.dbUser.id,
      organizationId: auth.organizationId,
    },
  })

  if (inlineExecution) {
    try {
      const result = await runAgentExecution({
        executionId: execution.id,
        agentId: agent.id,
        organizationId: auth.organizationId,
        userId: auth.dbUser.id,
        input: runInput,
      })
      return { success: true, executionId: execution.id, result }
    } catch (error) {
      await prisma.agentExecution.update({
        where: { id: execution.id, organizationId: auth.organizationId },
        data: {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          completedAt: new Date(),
        },
      })
      // Pass the real cause so Sentry sees it — otherwise inline failures report
      // the literal string "Agent run failed" and the actual error is lost.
      throw new ApiError('Agent run failed', 500, 'RUN_FAILED', error)
    }
  } else {
    if (!workersEnabled) throw new ApiError('Agent worker is disabled', 503, 'WORKER_DISABLED')
    try {
      const queue = createQueue(QUEUE_NAMES.AGENT_EXECUTION)
      await queue.add('execute-agent', {
        executionId: execution.id,
        agentId: agent.id,
        organizationId: auth.organizationId,
        userId: auth.dbUser.id,
        input: runInput,
      }, { jobId: execution.id })
    } catch (error) {
      await prisma.agentExecution.update({
        where: { id: execution.id, organizationId: auth.organizationId },
        data: { status: 'failed', error: error instanceof Error ? error.message : String(error), completedAt: new Date() },
      })
      throw new ApiError('Unable to queue agent execution', 503, 'QUEUE_UNAVAILABLE')
    }
    return { success: true, executionId: execution.id, status: 'pending' }
  }
}, { permission: 'agent.run' })

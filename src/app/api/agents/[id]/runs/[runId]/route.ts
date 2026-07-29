import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { notify } from '@/lib/notifications/service'
import { isCancellableRunStatus, isTerminalRunStatus, isWaitingRunStatus } from '@/lib/agents/run-status'

export const runtime = 'nodejs'

/**
 * Resolve {agentId, runId} from the path (`/api/agents/<agentId>/runs/<runId>`)
 * and enforce agent visibility (a private agent's runs are only actionable by
 * its owner).
 */
async function requireAgentAndRun(request: Request, auth: { organizationId: string; dbUser: { id: string } }) {
  const segments = new URL(request.url).pathname.split('/')
  const agentId = segments.at(-3)
  const runId = segments.at(-1)
  if (!agentId || !runId) throw new ApiError('Agent id and run id are required')

  const agent = await prisma.agentTask.findFirst({
    where: { id: agentId, organizationId: auth.organizationId, status: { not: 'DELETED' }, ...agentVisibilityScope(auth.dbUser.id) },
    select: { id: true, description: true },
  })
  if (!agent) throw new ApiError('Agent not found', 404, 'NOT_FOUND')

  const run = await prisma.agentExecution.findFirst({
    where: { id: runId, agentTaskId: agent.id, organizationId: auth.organizationId },
    select: { id: true, status: true, userId: true, metadata: true },
  })
  if (!run) throw new ApiError('Run not found', 404, 'NOT_FOUND')

  return { agent, run }
}

// POST { action: 'cancel' } — stop a running/waiting run.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const { agent, run } = await requireAgentAndRun(request, auth)
  z.object({ action: z.literal('cancel') }).parse(await request.json())

  if (!isCancellableRunStatus(run.status)) {
    throw new ApiError('Run is not cancellable', 409, 'NOT_CANCELLABLE')
  }

  // Waiting runs have no live turn loop to notice a flag — resume only happens
  // via a user reply/approval decision, so finalize them directly. Running
  // runs are flagged 'cancelling' for the turn loop to notice and exit cleanly.
  const nextStatus = isWaitingRunStatus(run.status) ? 'cancelled' : 'cancelling'
  const existingMetadata = run.metadata && typeof run.metadata === 'object' ? (run.metadata as Record<string, unknown>) : {}
  const data =
    nextStatus === 'cancelled'
      ? {
          status: 'cancelled',
          completedAt: new Date(),
          error: null,
          // Clear any stale pendingQuestion so the row stops showing the
          // question it was waiting on once it's cancelled.
          metadata: { ...existingMetadata, pendingQuestion: null },
        }
      : { status: 'cancelling' }

  const updated = await prisma.agentExecution.updateMany({
    where: { id: run.id, agentTaskId: agent.id, organizationId: auth.organizationId, status: run.status },
    data,
  })
  if (updated.count !== 1) {
    throw new ApiError('Run is not cancellable', 409, 'NOT_CANCELLABLE')
  }

  if (nextStatus === 'cancelled') {
    await prisma.workflowEvent.create({
      data: { executionId: run.id, stepId: null, kind: 'run.cancelled', payload: { reason: 'user_requested' } },
    })
    const title = existingMetadata.title as string | undefined
    await notify({
      organizationId: auth.organizationId,
      userId: run.userId,
      type: 'agent.cancelled',
      level: 'info',
      title: `${title || agent.description} run cancelled`,
      body: 'Run cancelled by the user.',
      agentTaskId: agent.id,
      executionId: run.id,
    })
  }

  return { success: true, status: nextStatus }
}, { permission: 'agent.run' })

// DELETE — remove a finished run from history (and its steps/events/messages).
export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { agent, run } = await requireAgentAndRun(request, auth)

  if (!isTerminalRunStatus(run.status)) {
    throw new ApiError('Run is still active', 409, 'RUN_ACTIVE')
  }

  // WorkflowStep, WorkflowEvent and ExecutionMessage all declare
  // `onDelete: Cascade` on their executionId relation to AgentExecution, so
  // the DB cascades their deletion — no manual child cleanup needed here.
  const deleted = await prisma.agentExecution.deleteMany({
    where: { id: run.id, agentTaskId: agent.id, organizationId: auth.organizationId, status: run.status },
  })
  if (deleted.count !== 1) {
    throw new ApiError('Run is still active', 409, 'RUN_ACTIVE')
  }

  return { success: true }
}, { permission: 'agent.run' })

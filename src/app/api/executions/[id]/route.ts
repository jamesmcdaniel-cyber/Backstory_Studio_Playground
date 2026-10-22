import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { executionVisibilityScope } from '@/lib/server/visibility'
import { removeExecutionFromGraph } from '@/lib/rag/indexer'
import { isTerminalRunStatus } from '@/lib/agents/run-status'

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-1)
  if (!id) throw new ApiError('Execution id is required')
  const scope = { id, organizationId: auth.organizationId, ...executionVisibilityScope(auth.dbUser.id) }
  const run = await prisma.agentExecution.findFirst({ where: scope, select: { status: true } })
  if (!run) throw new ApiError('Execution not found', 404, 'NOT_FOUND')
  // A run still in flight is cancelled first, then deleted (as the agent's
  // own runs route does): deleting it under its worker strands every later
  // write and leaves whatever is waiting on it — an artifact chat — spinning.
  if (!isTerminalRunStatus(run.status)) throw new ApiError('Run is still active. Cancel it first.', 409, 'RUN_ACTIVE')
  // Cascade removes workflow steps/events/messages via the schema relations.
  // Status-matched, so a run resumed since the read is not deleted.
  const result = await prisma.agentExecution.deleteMany({ where: { ...scope, status: run.status } })
  if (!result.count) throw new ApiError('Run is still active. Cancel it first.', 409, 'RUN_ACTIVE')
  // Drop the run's graph node so it can't resurface in retrieval. Best-effort.
  void removeExecutionFromGraph(auth.organizationId, id).catch(() => undefined)
  return { success: true }
}, { permission: 'agent.write' })

import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'

export const runtime = 'nodejs'

// POST /api/flows/[id]/cancel — request cancellation of an in-progress run.
// Flips FlowRun.status to 'cancelling'; the interpreter polls this once per tick
// (see execute-flow's isCancelled) and aborts, terminalizing the run as
// 'cancelled'. Org- + visibility-scoped (a private flow's run is cancellable
// only by its owner). id is the path segment before "cancel".
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  const { flowRunId } = z.object({ flowRunId: z.string().min(1) }).parse(await request.json())

  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
    select: { id: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')

  // Only an in-progress run can be cancelled; the status guard makes this a
  // no-op (count 0) for already-terminal runs.
  const result = await prisma.flowRun.updateMany({
    where: {
      id: flowRunId,
      flowId: flow.id,
      organizationId: auth.organizationId,
      status: { in: ['running', 'waiting'] },
    },
    data: { status: 'cancelling' },
  })
  if (result.count === 0) {
    throw new ApiError('This run has already finished or is not cancellable.', 409, 'FLOW_RUN_NOT_CANCELLABLE')
  }
  return { success: true, status: 'cancelling' }
}, { permission: 'flow.run' })

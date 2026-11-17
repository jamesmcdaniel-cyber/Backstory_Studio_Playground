import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { cancelFlowRun } from '@/lib/flows/cancel-run'

export const runtime = 'nodejs'

// POST /api/flows/[id]/cancel — request cancellation of an in-progress run.
// A `running` run flips to 'cancelling' for the interpreter to notice; a
// `waiting` run is cancelled on the spot (see cancelFlowRun for why each).
// Org- + visibility-scoped (a private flow's run is cancellable only by its
// owner). id is the path segment before "cancel".
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  const { flowRunId } = z.object({ flowRunId: z.string().min(1) }).parse(await request.json())

  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
    select: { id: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')

  const status = await cancelFlowRun({ organizationId: auth.organizationId, flowId: flow.id, flowRunId })
  if (!status) {
    throw new ApiError('This run has already finished or is not cancellable.', 409, 'FLOW_RUN_NOT_CANCELLABLE')
  }
  return { success: true, status }
}, { permission: 'flow.run' })

import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'

export const runtime = 'nodejs'

// POST /api/flows/[id]/cancel — request cancellation of an in-progress run.
// A `running` run flips to 'cancelling'; the interpreter polls this once per
// tick (see execute-flow's isCancelled) and aborts, terminalizing the run as
// 'cancelled' itself. A `waiting` run has no executor polling it — nothing
// would ever pick up 'cancelling' and finish the job — so it is cancelled
// immediately here, with its still-open step rows swept in the same request.
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

  // A waiting run completes the cancellation itself: there is no executor to
  // hand `cancelling` off to, so leaving it there would be a permanent dead
  // end. Try this branch first so a waiting run never falls through into the
  // 'cancelling' handoff below.
  //
  // The flip and the step sweep run inside one interactive transaction — the
  // same per-pair atomicity shape as the reaper (see src/lib/flows/reap.ts):
  // a crash between the two statements must never land a `cancelled` run
  // with its steps still `running`/`waiting` forever, since a `cancelled`
  // run's status guard means nothing revisits it to clean up steps it left
  // behind.
  const waitingResult = await prisma.$transaction(async (tx) => {
    const claimed = await tx.flowRun.updateMany({
      where: { id: flowRunId, flowId: flow.id, organizationId: auth.organizationId, status: 'waiting' },
      data: { status: 'cancelled', finishedAt: new Date() },
    })
    if (claimed.count === 0) return claimed
    await tx.flowRunStep.updateMany({
      where: { flowRunId, status: { in: ['running', 'waiting'] } },
      data: { status: 'cancelled', finishedAt: new Date() },
    })
    return claimed
  })
  if (waitingResult.count > 0) {
    return { success: true, status: 'cancelled' }
  }

  // Only a `running` run passes through 'cancelling' now — the interpreter's
  // own poll loop terminalizes it. The status guard makes this a no-op
  // (count 0) for a run that's already terminal.
  const result = await prisma.flowRun.updateMany({
    where: { id: flowRunId, flowId: flow.id, organizationId: auth.organizationId, status: 'running' },
    data: { status: 'cancelling' },
  })
  if (result.count === 0) {
    throw new ApiError('This run has already finished or is not cancellable.', 409, 'FLOW_RUN_NOT_CANCELLABLE')
  }
  return { success: true, status: 'cancelling' }
}, { permission: 'flow.run' })

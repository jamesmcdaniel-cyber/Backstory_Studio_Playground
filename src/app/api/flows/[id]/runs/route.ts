import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { deriveRunWaiting } from '@/lib/flows/run-waiting'

// GET /api/flows/[id]/runs — recent runs + each run's per-step detail (input,
// output, error), polled by the builder for live status and run inspection.
// id is the segment before "runs".
//
// Query params (all optional, additive — no-param behavior is unchanged aside
// from the `trigger` field always present on the shaped run now):
//   status=a,b   filter to a comma-separated set of run statuses
//   take=N       page size, default 20, capped at 100
//   summary=1    lighter payload for list views: steps carry only
//                {nodeId, status, order, error} and runs omit input/output
//                (error is still included) — used by the activity table so it
//                isn't shipping every run's full input/output over the wire.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  // Visibility gate: private-flow run history is owner-only.
  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
    select: { id: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')

  const searchParams = request.nextUrl.searchParams
  const statusList = (searchParams.get('status') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const takeParam = Number(searchParams.get('take'))
  const take = Number.isFinite(takeParam) && takeParam > 0 ? Math.min(100, Math.floor(takeParam)) : 20
  const summary = searchParams.get('summary') === '1'

  const runs = await prisma.flowRun.findMany({
    where: { flowId: id, organizationId: auth.organizationId, ...(statusList.length ? { status: { in: statusList } } : {}) },
    orderBy: { startedAt: 'desc' },
    take,
    include: {
      steps: {
        orderBy: { order: 'asc' },
        // output is always fetched (a waiting step stores its pause reason
        // there) but stripped from summary wire steps below to stay slim.
        select: summary
          ? { nodeId: true, status: true, order: true, error: true, output: true }
          : { nodeId: true, status: true, order: true, error: true, input: true, output: true, logs: true, startedAt: true, finishedAt: true, agentExecutionId: true },
      },
    },
  })
  const shape = (run: (typeof runs)[number]) => ({
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    trigger: run.trigger,
    ...(summary ? {} : { input: run.input, output: run.output }),
    error: run.error,
    // What the run is blocked on (agent question / approval), non-null only
    // when the run is waiting — reply UIs key off this.
    waiting: deriveRunWaiting(run.status, run.steps),
    steps: summary ? run.steps.map(({ nodeId, status, order, error }) => ({ nodeId, status, order, error })) : run.steps,
  })
  return {
    success: true,
    runs: runs.map(shape),
    latest: runs[0] ? shape(runs[0]) : null,
  }
})

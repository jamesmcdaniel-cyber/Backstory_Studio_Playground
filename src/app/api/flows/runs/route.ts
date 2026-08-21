import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { executionStepLabel } from '@/lib/flows/execution-log'

const RUN_STATUSES = new Set(['running', 'succeeded', 'failed', 'waiting', 'cancelled', 'cancelling'])

// GET /api/flows/runs — paginated execution history across every flow the
// current user can see in their workspace. Cross-workspace shared flows are
// deliberately absent: their run data remains in the owning workspace.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const searchParams = request.nextUrl.searchParams
  const requestedStatus = searchParams.get('status')?.trim() ?? ''
  const status = RUN_STATUSES.has(requestedStatus) ? requestedStatus : ''
  const pageParam = Number(searchParams.get('page'))
  const takeParam = Number(searchParams.get('take'))
  const page = Number.isFinite(pageParam) && pageParam > 0 ? Math.floor(pageParam) : 1
  const take = Number.isFinite(takeParam) && takeParam > 0 ? Math.min(100, Math.floor(takeParam)) : 20

  const flowScope = {
    organizationId: auth.organizationId,
    ...agentVisibilityScope(auth.dbUser.id),
  }
  const where = {
    organizationId: auth.organizationId,
    ...(status ? { status } : {}),
    flow: { is: flowScope },
  }

  const [total, runs] = await Promise.all([
    prisma.flowRun.count({ where }),
    prisma.flowRun.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      skip: (page - 1) * take,
      take,
      select: {
        id: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        trigger: true,
        error: true,
        degraded: true,
        graphSnapshot: true,
        flow: { select: { id: true, name: true, icon: true } },
        steps: {
          orderBy: { order: 'asc' },
          select: { nodeId: true, status: true, order: true, error: true, warnings: true },
        },
      },
    }),
  ])

  return {
    success: true,
    page,
    pageCount: Math.max(1, Math.ceil(total / take)),
    total,
    runs: runs.map((run) => ({
      id: run.id,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      trigger: run.trigger,
      error: run.error,
      degraded: run.degraded,
      flow: run.flow,
      steps: run.steps.map((step) => ({
        nodeId: step.nodeId,
        label: executionStepLabel(run.graphSnapshot, step.nodeId),
        status: step.status,
        order: step.order,
        error: step.error,
        warnings: Array.isArray(step.warnings)
          ? step.warnings.filter((entry): entry is string => typeof entry === 'string')
          : null,
      })),
    })),
  }
}, { permission: 'flow.read' })

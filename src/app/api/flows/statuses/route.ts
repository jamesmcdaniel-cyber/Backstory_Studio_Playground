import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { loadFlowOperationalStatuses } from '@/lib/flows/operational-status.server'

const idsSchema = z.array(z.string().min(1).max(100)).max(10)

// A deliberately small polling surface for flow cards. It never returns run
// ids, input, output, errors, or another workspace's activity.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const requestedIds = [...new Set(idsSchema.parse(request.nextUrl.searchParams.getAll('id')))]
  if (!requestedIds.length) return { success: true, statuses: {} }

  const visibleFlows = await prisma.flow.findMany({
    where: {
      id: { in: requestedIds },
      organizationId: auth.organizationId,
      ...agentVisibilityScope(auth.dbUser.id),
    },
    select: { id: true },
  })
  const statuses = await loadFlowOperationalStatuses(
    auth.organizationId,
    visibleFlows.map((flow) => flow.id),
  )

  return { success: true, statuses: Object.fromEntries(statuses) }
}, { permission: 'flow.read' })

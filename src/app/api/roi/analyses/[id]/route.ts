import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { loadRoiAnalysis, serializeRoiAnalysis } from '@/lib/roi/service'

export const runtime = 'nodejs'

// GET /api/roi/analyses/:id — the analysis, reconciled with its data flow and
// its run (status and phase, report rendered once the run finished). The ROI
// page polls it while a run is in flight.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = new URL(request.url).pathname.split('/').at(-1)
  if (!id) throw new ApiError('Analysis id is required.', 400, 'ID_REQUIRED')
  const row = await loadRoiAnalysis(auth.organizationId, id)
  if (!row) throw new ApiError('Analysis not found.', 404, 'NOT_FOUND')
  const requester = await prisma.user.findFirst({ where: { id: row.userId, organizationId: auth.organizationId }, select: { name: true, email: true } })
  return { success: true, analysis: serializeRoiAnalysis(row, requester ? requester.name?.trim() || requester.email || null : null) }
}, { permission: 'agent.read', internalOnly: true })

import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { loadRoiAnalysis, serializeRoiAnalysis } from '@/lib/roi/service'

export const runtime = 'nodejs'

// GET /api/roi/analyses/:id — the analysis, reconciled with its run (status,
// report rendered once the run finished, pending answers filled in).
export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = new URL(request.url).pathname.split('/').at(-1)
  if (!id) throw new ApiError('Analysis id is required.', 400, 'ID_REQUIRED')
  const row = await loadRoiAnalysis(auth.organizationId, id)
  if (!row) throw new ApiError('Analysis not found.', 404, 'NOT_FOUND')
  return { success: true, analysis: serializeRoiAnalysis(row) }
}, { permission: 'agent.read', internalOnly: true })

import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { findFlowTemplate } from '@/lib/flows/templates/catalogue'

// GET /api/flow-templates/[id] — one template, built-in or stored. A stored row
// is readable when the viewer's org owns it or it is published globally;
// findFlowTemplate holds that boundary.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-1)
  if (!id) throw new ApiError('Template id is required')
  const template = await findFlowTemplate(id, auth.organizationId)
  if (!template) throw new ApiError('Flow template not found', 404, 'NOT_FOUND')
  return { success: true, template }
}, { permission: 'flow.read' })

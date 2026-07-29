import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { findFlowTemplate } from '@/lib/flows/templates/catalogue'
import { instantiateFlowTemplate } from '@/lib/flows/templates/instantiate'
import { serializeFlow } from '@/lib/flows/serialize'
import { recordAudit } from '@/lib/audit'

// POST /api/flow-templates/[id]/use — turn a template into a DRAFT flow.
// Always creates the flow, even when bindings don't resolve: unfilled slots come
// back as `setup` for the builder's "Finish setup" panel rather than blocking.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Template id is required')

  const template = await findFlowTemplate(id, auth.organizationId)
  if (!template) throw new ApiError('Flow template not found', 404, 'NOT_FOUND')

  const { flow, setup, issues } = await instantiateFlowTemplate(auth.organizationId, auth.dbUser.id, template)
  void recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.dbUser.id,
    action: 'flow.created',
    resourceType: 'flow',
    resourceId: flow.id,
    detail: { fromTemplate: template.id, templateName: template.name, unresolvedSetup: setup.length },
  }).catch(() => undefined)

  return { success: true, flow: serializeFlow(flow), setup, issues }
}, { permission: 'flow.write' })

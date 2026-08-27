import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { publishFlowDraft, revertFlowDraft, unpublishFlowDraft } from '@/lib/flows/publish-service'

// POST /api/flows/[id]/publish — publish the draft, revert the draft to the
// live snapshot, or unpublish. The service is shared with MCP/public builders
// so every entry point honors the same review and validation gates.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const flowId = request.nextUrl.pathname.split('/').at(-2)
  if (!flowId) throw new ApiError('Flow id is required')
  const { revert, unpublish } = z
    .object({ revert: z.boolean().default(false), unpublish: z.boolean().default(false) })
    .parse(await request.json().catch(() => ({})))
  if (revert && unpublish) throw new ApiError('Pick one publish action.', 400, 'INVALID_PUBLISH_ACTION')

  const actor = { flowId, organizationId: auth.organizationId, userId: auth.dbUser.id }
  const flow = revert
    ? await revertFlowDraft(actor)
    : unpublish
      ? await unpublishFlowDraft(actor)
      : await publishFlowDraft(actor)
  return { success: true, flow }
}, { permission: 'flow.write' })

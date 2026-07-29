import { prisma, systemPrisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { resolveFlowRole } from '@/lib/flows/access'
import { serializeFlow } from '@/lib/flows/serialize'
import { recordAudit } from '@/lib/audit'

// GET /api/flows/[id]?share=<token> — single-flow fetch that resolves access
// beyond the caller's org: same-org visibility, an accepted collaborator row,
// or a valid share token. A token's first cross-org open UPSERTS the
// collaborator row — that IS invite acceptance; later opens need no token.
// Everyone else gets a 404 indistinguishable from a missing flow.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-1)
  if (!id) throw new ApiError('Flow id is required')
  const token = request.nextUrl.searchParams.get('share')
  // systemPrisma: deliberately cross-tenant — share links resolve access
  // BEYOND the caller's org; resolveFlowRole below is the access boundary
  // (owner/org/collaborator/token), and failures 404 without leaking.
  const flow = await systemPrisma.flow.findUnique({
    where: { id },
    include: { collaborators: { where: { userId: auth.dbUser.id } } },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  const viewer = { userId: auth.dbUser.id, organizationId: auth.organizationId }
  const role = resolveFlowRole({ ...flow, collaboratorRole: flow.collaborators[0]?.role ?? null }, viewer, token)
  if (!role) {
    // A caller who PRESENTED a token that doesn't match is told the link is
    // dead — they already hold a token, so this leaks nothing new, and it's the
    // only way rotation is comprehensible. Everyone else gets a plain 404 that
    // can't distinguish "missing" from "not yours".
    if (token && token !== flow.shareToken) {
      throw new ApiError('This share link is no longer valid.', 404, 'SHARE_LINK_INVALID')
    }
    throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  }
  const external = flow.organizationId !== auth.organizationId
  if (external && !flow.collaborators.length && token && token === flow.shareToken) {
    // Acceptance: the durable grant. Idempotent — re-opens never duplicate.
    await prisma.flowCollaborator.upsert({
      where: { flowId_userId: { flowId: flow.id, userId: auth.dbUser.id } },
      create: { flowId: flow.id, userId: auth.dbUser.id, role },
      update: {},
    })
    void recordAudit({
      organizationId: flow.organizationId,
      actorUserId: auth.dbUser.id,
      action: 'flow.share_accepted',
      resourceType: 'flow',
      resourceId: flow.id,
      detail: { role },
    }).catch(() => undefined)
  }
  return {
    success: true,
    flow: serializeFlow(flow, auth.dbUser.id, { role, external, includeShare: !external && role === 'edit' }),
  }
})

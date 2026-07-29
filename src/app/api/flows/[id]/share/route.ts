import { randomBytes } from 'crypto'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { assertFlowEditable } from '@/lib/flows/access'
import { recordAudit } from '@/lib/audit'

const bodySchema = z.object({
  enabled: z.boolean(),
  role: z.enum(['view', 'edit']).default('view'),
  rotate: z.boolean().optional(),
})

// POST /api/flows/[id]/share — manage the cross-workspace share link. Only a
// same-org EDITOR may manage sharing (the org-scoped lookup below is that
// wall — guests can never reach this). Enabling mints a token when none
// exists and otherwise keeps it (so changing the role doesn't break sent
// links); `rotate: true` forces a fresh token (old links stop working);
// disabling clears it. Rotation does NOT remove already-accepted
// collaborators — their rows are durable grants.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
    select: { id: true, visibility: true, userId: true, shareToken: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  assertFlowEditable(flow, auth.dbUser.id)
  const { enabled, role, rotate } = bodySchema.parse(await request.json())
  const shareToken = !enabled ? null : rotate || !flow.shareToken ? randomBytes(16).toString('hex') : flow.shareToken
  const updated = await prisma.flow.update({
    where: { id: flow.id, organizationId: auth.organizationId },
    data: { shareToken, shareRole: role },
  })
  void recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.dbUser.id,
    action: enabled ? 'flow.share_link_enabled' : 'flow.share_link_disabled',
    resourceType: 'flow',
    resourceId: flow.id,
    detail: { role, rotated: Boolean(rotate) },
  }).catch(() => undefined)
  return { success: true, shareToken: updated.shareToken, shareRole: updated.shareRole === 'edit' ? 'edit' : 'view' }
}, { permission: 'flow.write' })

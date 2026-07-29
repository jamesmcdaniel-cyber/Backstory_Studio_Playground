import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { assertFlowEditable } from '@/lib/flows/access'
import { notify } from '@/lib/notifications/service'
import { recordAudit } from '@/lib/audit'
import { rateLimit } from '@/lib/ratelimit'

const bodySchema = z.object({ userIds: z.array(z.string().min(1)).min(1).max(50) })

// POST /api/flows/[id]/invite — invite workspace members to jam on this flow.
// Each invitee gets an in-app notification + web push that deep-links straight
// to the flow (with the login return_to fix, they land on it after signing in).
// Only an EDITOR can invite, and only when the flow is shareable — a private
// flow can't be opened by anyone else, so inviting to it would just 403 the
// recipient. Invitees must be members of this workspace (org-scoped lookup).
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  // Each invite fires an in-app notification + web push. Throttle per inviter so
  // the endpoint can't be looped to flood colleagues with notifications.
  const limited = await rateLimit(`flow-invite:${auth.dbUser.id}`, { limit: 10, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('You’re inviting too quickly — try again in a moment.', 429, 'RATE_LIMITED')
  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
    select: { id: true, name: true, visibility: true, userId: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  assertFlowEditable(flow, auth.dbUser.id)
  if (flow.visibility === 'private') {
    throw new ApiError('This flow is private — set it to “Everyone can view/edit” before inviting people.', 400, 'FLOW_PRIVATE')
  }

  const { userIds } = bodySchema.parse(await request.json())
  // Only real, active members of THIS workspace (never invite across tenants),
  // and never notify the inviter themselves.
  const recipients = await prisma.user.findMany({
    where: { id: { in: userIds }, organizationId: auth.organizationId, NOT: { id: auth.dbUser.id } },
    select: { id: true, name: true, email: true },
  })
  const inviterName = auth.dbUser.name || auth.dbUser.email || 'A teammate'
  await Promise.all(
    recipients.map((r) =>
      notify({
        organizationId: auth.organizationId,
        userId: r.id,
        type: 'flow.jam_invite',
        level: 'action',
        title: `${inviterName} invited you to jam`,
        body: `Join “${flow.name}” to edit it together in real time.`,
        link: `/flows/${flow.id}`,
      }),
    ),
  )
  await recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.dbUser.id,
    action: 'flow.invited',
    resourceType: 'flow',
    resourceId: flow.id,
    detail: { invited: recipients.map((r) => r.id) },
  }).catch(() => undefined)

  return { success: true, invited: recipients.length }
}, { permission: 'flow.write' })

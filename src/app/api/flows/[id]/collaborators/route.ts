import { z } from 'zod'
import { prisma, systemPrisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { assertFlowEditable } from '@/lib/flows/access'
import { recordAudit } from '@/lib/audit'

// GET /api/flows/[id]/collaborators — the cross-workspace guests who accepted
// a share link for this flow. Same-org EDITORS only (the org-scoped flow
// lookup is that wall — a guest can never list or remove other guests).
// DELETE — { userId } revokes one guest's access; their next open (and their
// next realtime join — flow_topic_access reads these rows) is refused.
// id is the path segment before "collaborators".

async function requireEditableFlow(id: string, organizationId: string, viewerId: string) {
  const flow = await prisma.flow.findFirst({
    where: { id, organizationId, ...agentVisibilityScope(viewerId) },
    select: { id: true, visibility: true, userId: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  assertFlowEditable(flow, viewerId)
  return flow
}

export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  await requireEditableFlow(id, auth.organizationId, auth.dbUser.id)

  const rows = await prisma.flowCollaborator.findMany({
    where: { flow: { id, organizationId: auth.organizationId } },
    orderBy: { createdAt: 'asc' },
  })
  // systemPrisma: collaborators are BY DEFINITION users from other workspaces,
  // so an org-scoped user lookup would find none of them. Read-only, limited
  // to ids taken from this flow's own collaborator rows, exposing only what a
  // guest already showed this workspace by joining (name/email).
  const users = rows.length
    ? await systemPrisma.user.findMany({
        where: { id: { in: rows.map((row) => row.userId) } },
        select: { id: true, name: true, email: true },
      })
    : []
  const byId = new Map(users.map((user) => [user.id, user]))
  return {
    success: true,
    collaborators: rows.map((row) => ({
      userId: row.userId,
      role: row.role === 'edit' ? 'edit' : 'view',
      joinedAt: row.createdAt,
      name: byId.get(row.userId)?.name ?? null,
      email: byId.get(row.userId)?.email ?? null,
    })),
  }
}, { permission: 'flow.write' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  await requireEditableFlow(id, auth.organizationId, auth.dbUser.id)
  const { userId } = z.object({ userId: z.string().min(1) }).parse(await request.json())

  const removed = await prisma.flowCollaborator.deleteMany({
    where: { userId, flow: { id, organizationId: auth.organizationId } },
  })
  if (!removed.count) throw new ApiError('That person no longer has access.', 404, 'NOT_FOUND')
  void recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.dbUser.id,
    action: 'flow.collaborator_removed',
    resourceType: 'flow',
    resourceId: id,
    detail: { removedUserId: userId },
  }).catch(() => undefined)
  return { success: true }
}, { permission: 'flow.write' })

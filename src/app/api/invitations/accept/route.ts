import { z } from 'zod'
import { prisma, systemPrisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { hashToken } from '@/lib/crypto/secrets'
import { transferUserToOrganization } from '@/lib/org-transfer'
import type { UserRole } from '@prisma/client'

const schema = z.object({ token: z.string().min(1) })

// Accept an invitation as the signed-in user: move them into the inviting
// workspace with the invited role. Membership is a single-org FK, so this
// reassigns the user's organizationId (their prior solo workspace, if any, is
// left behind). Idempotent if they're already in that workspace.
//
// The move goes through transferUserToOrganization, which also revokes the
// per-user credential rows stamped with the workspace being left — otherwise
// their integrations, People.ai tokens, MCP servers and push subscriptions stay
// readable by their old org and unusable in the new one.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const { token } = schema.parse(await request.json())
  // systemPrisma: accepting an invite necessarily resolves a capability token
  // before the destination tenant is known. All subsequent writes use the
  // resolved organizationId explicitly.
  const invite = await systemPrisma.invitation.findFirst({
    where: { tokenHash: hashToken(token), status: 'PENDING', expiresAt: { gt: new Date() } },
    select: { id: true, organizationId: true, role: true },
  })
  if (!invite) throw new ApiError('This invitation is invalid or has expired.', 404, 'INVITE_INVALID')

  // Invitation.role is free text (the table predates the enum), so an unknown
  // value falls back to the member tier rather than failing the join.
  const INVITABLE_ROLES = ['ADMIN', 'USER', 'OWNER', 'VIEWER']
  const role = (INVITABLE_ROLES.includes(invite.role) ? invite.role : 'USER') as UserRole
  await prisma.$transaction(async (tx) => {
    await transferUserToOrganization(tx, {
      userId: auth.dbUser.id,
      fromOrganizationId: auth.organizationId,
      toOrganizationId: invite.organizationId,
      role,
    })
    await tx.invitation.update({
      where: { id: invite.id, organizationId: invite.organizationId },
      data: { status: 'ACCEPTED', acceptedByUserId: auth.dbUser.id, acceptedAt: new Date() },
    })
  })

  // No auth cache to bust — the row is read fresh per request, so the next call
  // already resolves the new workspace and role.
  return { success: true }
}, { permission: null })

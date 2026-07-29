import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { hashToken } from '@/lib/crypto/secrets'
import { invalidateAuthCache } from '@/lib/supabase/auth-utils'

const schema = z.object({ token: z.string().min(1) })

// Accept an invitation as the signed-in user: move them into the inviting
// workspace with the invited role. Membership is a single-org FK, so this
// reassigns the user's organizationId (their prior solo workspace, if any, is
// left behind). Idempotent if they're already in that workspace.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const { token } = schema.parse(await request.json())
  const invite = await prisma.invitation.findFirst({
    where: { tokenHash: hashToken(token), status: 'PENDING', expiresAt: { gt: new Date() } },
    select: { id: true, organizationId: true, role: true },
  })
  if (!invite) throw new ApiError('This invitation is invalid or has expired.', 404, 'INVITE_INVALID')

  const role = invite.role === 'ADMIN' ? 'ADMIN' : 'USER'
  const alreadyMember = auth.organizationId === invite.organizationId

  await prisma.$transaction(async (tx) => {
    if (!alreadyMember) {
      await tx.user.update({
        where: { id: auth.dbUser.id },
        data: { organizationId: invite.organizationId, role },
      })
    }
    await tx.invitation.update({
      where: { id: invite.id },
      data: { status: 'ACCEPTED', acceptedByUserId: auth.dbUser.id, acceptedAt: new Date() },
    })
  })

  // The auth row is cached per-instance; drop it so the next request sees the
  // new workspace/role instead of the stale one.
  invalidateAuthCache(auth.dbUser.supabaseId)
  return { success: true }
}, { permission: null })

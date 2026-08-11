import type { NextRequest } from 'next/server'
import { prisma, systemPrisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

// Revoke a pending invitation. Admin-only, same-workspace only.
export const DELETE = withAuthenticatedApi(async (request: NextRequest, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-1)
  if (!id) throw new ApiError('Invitation id is required')
  const invitation = await prisma.invitation.findFirst({
    where: { id, organizationId: auth.organizationId, status: 'PENDING' },
    select: { id: true, email: true },
  })
  if (!invitation) throw new ApiError('Invitation not found', 404, 'NOT_FOUND')
  await prisma.invitation.updateMany({
    where: { id: invitation.id, organizationId: auth.organizationId, status: 'PENDING' },
    data: { status: 'REVOKED' },
  })
  // A super-admin invite parked an unclaimed grant against this address. Revoke
  // has to take that with it, or the tier would still land on first sign-in
  // through some other route in. Claimed rows are history and stay put.
  if (auth.can('catalogue.review')) {
    await systemPrisma.platformStaffEmail.deleteMany({ where: { email: invitation.email, claimedAt: null } })
  }
  return { success: true }
}, { permission: 'members.manage' })

import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

// Revoke a pending invitation. Admin-only, same-workspace only.
export const DELETE = withAuthenticatedApi(async (request: NextRequest, auth) => {
  if (auth.dbUser.role !== 'ADMIN') throw new ApiError('Admin access required', 403, 'FORBIDDEN')
  const id = request.nextUrl.pathname.split('/').at(-1)
  if (!id) throw new ApiError('Invitation id is required')
  const result = await prisma.invitation.updateMany({
    where: { id, organizationId: auth.organizationId, status: 'PENDING' },
    data: { status: 'REVOKED' },
  })
  if (result.count === 0) throw new ApiError('Invitation not found', 404, 'NOT_FOUND')
  return { success: true }
}, { permission: 'members.manage' })

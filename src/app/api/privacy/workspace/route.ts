import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { teardownOrganization } from '@/lib/org-teardown'

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { confirmation } = z.object({ confirmation: z.string() }).parse(await request.json())
  const organization = await prisma.organization.findUnique({ where: { id: auth.organizationId }, select: { name: true } })
  if (!organization || confirmation.trim() !== organization.name) {
    throw new ApiError('Type the exact workspace name to confirm deletion.', 400, 'CONFIRMATION_REQUIRED')
  }
  await teardownOrganization(auth.organizationId)
  return { success: true }
}, { permission: 'workspace.delete', skipBackstoryGate: true, skipEntitlementGate: true })

import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { resolveInternalOrgId } from '@/lib/catalogue/publish'
import { recordAudit } from '@/lib/audit'
import type { NextRequest } from 'next/server'

type Context = { params: Promise<{ id: string }> }

// Takedown: retire a published entry. isActive=false is what every catalogue
// read already filters on, so the entry stops being served without the row (and
// its audit trail) being destroyed.
export const DELETE = withAuthenticatedApi(async (_request: NextRequest, auth, context?: unknown) => {
  const { id } = await (context as Context).params
  const internalOrgId = await resolveInternalOrgId()

  const retired =
    (await prisma.agentTemplate.updateMany({ where: { id, organizationId: internalOrgId }, data: { isActive: false } })).count ||
    (await prisma.flowTemplate.updateMany({ where: { id, organizationId: internalOrgId }, data: { isActive: false } })).count ||
    (await prisma.sharedSkill.updateMany({ where: { id, organizationId: internalOrgId }, data: { isActive: false } })).count

  if (!retired) throw new ApiError('That catalogue entry does not exist.', 404, 'NOT_FOUND')

  await recordAudit({
    organizationId: auth.organizationId,
    action: 'catalogue.takedown',
    actorUserId: auth.dbUser.id,
    resourceId: id,
  })
  return { success: true }
}, { permission: 'catalogue.takedown' })

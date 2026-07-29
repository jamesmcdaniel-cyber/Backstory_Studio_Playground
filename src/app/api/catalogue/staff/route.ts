import { z } from 'zod'
import { systemPrisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordAudit } from '@/lib/audit'
import { invalidateAuthCache } from '@/lib/supabase/auth-utils'

const patchSchema = z
  .object({
    userId: z.string().min(1).optional(),
    /** null clears the flag; 'staff' marks an employee; 'reviewer' grants review. */
    platformRole: z.enum(['staff', 'reviewer']).nullable().optional(),
    organizationId: z.string().uuid().optional(),
    orgKind: z.enum(['internal', 'partner', 'customer']).optional(),
  })
  .refine((value) => (value.userId ? value.platformRole !== undefined : true), {
    message: 'Say which platform role to set for that user.',
    path: ['platformRole'],
  })
  .refine((value) => (value.organizationId ? value.orgKind !== undefined : true), {
    message: 'Say which tier to set for that workspace.',
    path: ['orgKind'],
  })

// Staff and workspace-tier administration. systemPrisma throughout: granting
// review rights necessarily reaches into OTHER workspaces (marking People.ai a
// partner, promoting a colleague), which is why it needs catalogue.review.
export const GET = withAuthenticatedApi(async () => {
  const organizations = await systemPrisma.organization.findMany({
    where: { kind: { in: ['internal', 'partner'] } },
    select: { id: true, name: true, slug: true, kind: true },
    orderBy: { name: 'asc' },
  })
  const users = await systemPrisma.user.findMany({
    where: { organizationId: { in: organizations.map((org) => org.id) }, isActive: true },
    select: { id: true, email: true, name: true, role: true, platformRole: true, organizationId: true },
    orderBy: { email: 'asc' },
    take: 500,
  })
  return { success: true, organizations, users }
}, { permission: 'catalogue.review' })

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const data = patchSchema.parse(await request.json())

  if (data.userId) {
    const target = await systemPrisma.user.update({
      where: { id: data.userId },
      data: { platformRole: data.platformRole ?? null },
      select: { supabaseId: true },
    })
    // The auth row is cached for a minute; without this the change would not
    // take effect until it expired.
    invalidateAuthCache(target.supabaseId)
    await recordAudit({
      organizationId: auth.organizationId,
      action: 'catalogue.platform_role_set',
      actorUserId: auth.dbUser.id,
      resourceType: 'user',
      resourceId: data.userId,
      detail: { platformRole: data.platformRole ?? null },
    })
  }

  if (data.organizationId) {
    // Demoting the last internal org would leave published entries ownerless
    // and break resolveInternalOrgId, so refuse rather than half-apply it.
    if (data.orgKind !== 'internal') {
      const internalCount = await systemPrisma.organization.count({ where: { kind: 'internal' } })
      const target = await systemPrisma.organization.findUnique({
        where: { id: data.organizationId },
        select: { kind: true },
      })
      if (target?.kind === 'internal' && internalCount <= 1) {
        throw new ApiError(
          'That is the only internal workspace — published catalogue entries would have no owner.',
          409,
          'LAST_INTERNAL_ORG',
        )
      }
    }
    await systemPrisma.organization.update({
      where: { id: data.organizationId },
      data: { kind: data.orgKind },
    })
    await recordAudit({
      organizationId: auth.organizationId,
      action: 'catalogue.org_kind_set',
      actorUserId: auth.dbUser.id,
      resourceType: 'organization',
      resourceId: data.organizationId,
      detail: { kind: data.orgKind ?? null },
    })
  }

  return { success: true }
}, { permission: 'catalogue.review' })

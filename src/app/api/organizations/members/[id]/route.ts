import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordAudit } from '@/lib/audit'
import { isCustomerEdition } from '@/lib/edition'
import {
  isPlatformOwnerEmail,
  OWNER_PROTECTED_CODE,
  OWNER_PROTECTED_MESSAGE,
  OWNER_RESERVED_CODE,
  OWNER_RESERVED_MESSAGE,
} from '@/lib/authz/platform-owner'
import {
  dormantSuperAdminReason,
  isSuperAdminPlatformRole,
  SUPER_ADMIN_PLATFORM_ROLE,
} from '@/lib/authz/platform-roles'

function memberId(request: NextRequest) {
  const id = request.nextUrl.pathname.split('/').at(-1)
  if (!id) throw new ApiError('Member id is required')
  return id
}

// Roles that can administer a workspace. OWNER is a superset of ADMIN in the
// permission registry, so it satisfies the last-admin guard too.
const ADMINISTRATIVE_ROLES = ['ADMIN', 'OWNER'] as const

// Guard: refuse to leave the workspace without an administrator. Called before
// any change that would drop the last one (demotion or removal).
async function assertNotLastAdmin(organizationId: string, excludeUserId: string) {
  const admins = await prisma.user.count({
    where: {
      organizationId,
      isActive: true,
      role: { in: [...ADMINISTRATIVE_ROLES] },
      // The row being demoted/removed is about to stop counting, so exclude it
      // rather than comparing against an off-by-one threshold.
      NOT: { id: excludeUserId },
    },
  })
  if (admins < 1) throw new ApiError('Your workspace needs at least one admin.', 400, 'LAST_ADMIN')
}

const roleSchema = z.object({
  role: z.enum(['ADMIN', 'USER', 'OWNER', 'VIEWER']),
  // Super admin is a platform tier, not a workspace role, so the member select
  // sends both columns: { role: 'ADMIN', platformRole: 'reviewer' } to promote,
  // { role, platformRole: null } to demote. OMITTED means "leave it alone" —
  // which is what keeps an ordinary role change from silently clearing the
  // 'staff' employee marker off someone who happens to carry it.
  platformRole: z.literal(SUPER_ADMIN_PLATFORM_ROLE).nullable().optional(),
})

const administrative = (role: string) => (ADMINISTRATIVE_ROLES as readonly string[]).includes(role)

// Change a member's role. Same-workspace only, never demotes the last
// administrator. Authorization is the members.manage gate below — the inline
// `role !== 'ADMIN'` check this used to carry predates the permission registry
// and refused an OWNER, who the registry grants members.manage.
export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const id = memberId(request)
  const { role, platformRole } = roleSchema.parse(await request.json())
  const target = await prisma.user.findFirst({
    where: { id, organizationId: auth.organizationId, isActive: true },
    select: { id: true, role: true, email: true, platformRole: true },
  })
  if (!target) throw new ApiError('Member not found', 404, 'NOT_FOUND')
  // The platform owner's role is immutable — for everyone, including other
  // admins and the owner themself. OWNER itself is only grantable to the
  // platform owner identities. (A users-table trigger backstops both rules.)
  if (isPlatformOwnerEmail(target.email)) throw new ApiError(OWNER_PROTECTED_MESSAGE, 403, OWNER_PROTECTED_CODE)
  if (role === 'OWNER' && !isPlatformOwnerEmail(target.email)) {
    throw new ApiError(OWNER_RESERVED_MESSAGE, 403, OWNER_RESERVED_CODE)
  }
  if (administrative(target.role) && !administrative(role)) {
    await assertNotLastAdmin(auth.organizationId, target.id)
  }

  // Promoting or demoting a SUPER ADMIN is a platform-tier change, and
  // members.manage does not buy it: only someone who already holds review
  // rights may hand them out. Absent in the customer edition entirely, which
  // ships no operator tier at all.
  const changesPlatformTier =
    platformRole !== undefined && isSuperAdminPlatformRole(platformRole) !== isSuperAdminPlatformRole(target.platformRole)
  if (changesPlatformTier) {
    if (isCustomerEdition()) throw new ApiError('Not found', 404, 'NOT_FOUND')
    if (!auth.can('catalogue.review')) {
      throw new ApiError('Only a super admin can grant or revoke super admin.', 403, 'SUPER_ADMIN_REQUIRED')
    }
  }

  const member = await prisma.user.update({
    where: { id: target.id },
    // `platformRole: undefined` is Prisma's no-op, which is exactly the
    // "leave the employee marker alone" case the schema comment describes.
    data: { role, platformRole: changesPlatformTier ? platformRole : undefined },
    select: { id: true, name: true, email: true, role: true, platformRole: true },
  })

  let warning: string | null = null
  if (changesPlatformTier) {
    await recordAudit({
      organizationId: auth.organizationId,
      action: 'catalogue.platform_role_set',
      actorUserId: auth.dbUser.id,
      resourceType: 'user',
      resourceId: target.id,
      detail: { platformRole: platformRole ?? null, via: 'members' },
    })
    if (platformRole === SUPER_ADMIN_PLATFORM_ROLE) {
      const org = await prisma.organization.findUnique({
        where: { id: auth.organizationId },
        select: { kind: true },
      })
      warning = dormantSuperAdminReason(org?.kind)
    }
  }
  // No cache to bust: the auth row is read fresh per request, so a promoted
  // member picks the tier up on their next call.
  return { success: true, member, warning }
}, { permission: 'members.manage' })

// Remove a member from the workspace (soft — deactivate so their history stays
// intact). Admin-only; can't remove yourself or the last admin.
export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const id = memberId(request)
  if (id === auth.dbUser.id) throw new ApiError('You can’t remove yourself.', 400, 'SELF_REMOVE')
  const target = await prisma.user.findFirst({
    where: { id, organizationId: auth.organizationId, isActive: true },
    select: { id: true, role: true, email: true },
  })
  if (!target) throw new ApiError('Member not found', 404, 'NOT_FOUND')
  // The platform owner cannot be removed from a workspace by anyone.
  if (isPlatformOwnerEmail(target.email)) throw new ApiError(OWNER_PROTECTED_MESSAGE, 403, OWNER_PROTECTED_CODE)
  if (administrative(target.role)) await assertNotLastAdmin(auth.organizationId, target.id)
  await prisma.user.update({ where: { id: target.id }, data: { isActive: false } })
  return { success: true }
}, { permission: 'members.manage' })

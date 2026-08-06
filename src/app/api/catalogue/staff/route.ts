import { z } from 'zod'
import { systemPrisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordAudit } from '@/lib/audit'
import { DEFAULT_PLATFORM_STAFF_EMAILS, normalizeStaffEmail } from '@/lib/catalogue/staff-emails'

const patchSchema = z
  .object({
    userId: z.string().min(1).optional(),
    /** Grant/revoke by address instead of userId — works pre-first-sign-in. */
    email: z.string().trim().email().max(320).optional(),
    /** null clears the flag; 'staff' marks an employee; 'reviewer' grants review. */
    platformRole: z.enum(['staff', 'reviewer']).nullable().optional(),
    organizationId: z.string().uuid().optional(),
    orgKind: z.enum(['internal', 'partner', 'customer']).optional(),
  })
  .refine((value) => (value.userId || value.email ? value.platformRole !== undefined : true), {
    message: 'Say which platform role to set for that user.',
    path: ['platformRole'],
  })
  .refine((value) => (value.email ? value.platformRole !== 'staff' : true), {
    message: 'Email grants are for super admins — use the person list for the staff marker.',
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
  // Grants waiting on a first sign-in. Claimed rows are history, not state.
  const pendingStaff = await systemPrisma.platformStaffEmail.findMany({
    where: { claimedAt: null },
    select: { id: true, email: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })
  return { success: true, organizations, users, pendingStaff }
}, { permission: 'catalogue.review', internalOnly: true })

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const data = patchSchema.parse(await request.json())

  if (data.email) {
    const email = normalizeStaffEmail(data.email)!
    let warning: string | null = null

    if (!data.platformRole && DEFAULT_PLATFORM_STAFF_EMAILS.includes(email)) {
      // The hardcoded platform admin is re-promoted on every sign-in, so a
      // revoke here would silently undo itself. Refuse instead of pretending.
      throw new ApiError('That address is the built-in platform admin and cannot be revoked here.', 409, 'BUILTIN_STAFF')
    }

    const existing = await systemPrisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, isActive: true },
      select: { id: true, organization: { select: { kind: true } } },
    })

    let grant: 'updated' | 'pending' | 'removed'
    if (existing) {
      await systemPrisma.user.update({
        where: { id: existing.id },
        data: { platformRole: data.platformRole ?? null },
        select: { id: true },
      })
      // A pending row for an account that now exists is stale either way.
      await systemPrisma.platformStaffEmail.deleteMany({ where: { email, claimedAt: null } })
      grant = data.platformRole ? 'updated' : 'removed'
      if (data.platformRole === 'reviewer' && existing.organization && !['internal', 'partner'].includes(existing.organization.kind)) {
        warning =
          'Granted, but dormant: their workspace is a customer workspace. Review rights activate once the workspace is marked internal or partner below.'
      }
    } else if (data.platformRole) {
      await systemPrisma.platformStaffEmail.upsert({
        where: { email },
        update: { addedByUserId: auth.dbUser.id, claimedAt: null, claimedByUserId: null },
        create: { email, addedByUserId: auth.dbUser.id },
      })
      grant = 'pending'
    } else {
      await systemPrisma.platformStaffEmail.deleteMany({ where: { email } })
      grant = 'removed'
    }

    await recordAudit({
      organizationId: auth.organizationId,
      action: 'catalogue.platform_role_set',
      actorUserId: auth.dbUser.id,
      resourceType: 'staff_email',
      resourceId: existing?.id ?? email,
      detail: { email, platformRole: data.platformRole ?? null, grant },
    })
    return { success: true, grant, warning }
  }

  if (data.userId) {
    await systemPrisma.user.update({
      where: { id: data.userId },
      data: { platformRole: data.platformRole ?? null },
      select: { supabaseId: true },
    })
    // No cache to bust: the auth row is read fresh per request (see the note in
    // src/lib/supabase/auth-utils.ts), so this takes effect on the next call.
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
}, { permission: 'catalogue.review', internalOnly: true })

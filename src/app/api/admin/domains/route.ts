import { z } from 'zod'
import { systemPrisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordAudit } from '@/lib/audit'
import { normalizeDomain, isPublicEmailProvider, COMPANY_EMAIL_DOMAINS } from '@/lib/auth/company-domain'

const postSchema = z.object({
  domain: z.string().min(1),
  organizationId: z.string().uuid(),
  note: z.string().max(500).optional(),
})

const patchSchema = z.object({
  id: z.string().min(1),
  disabled: z.boolean(),
  /** When disabling, also deactivate that domain's users immediately. */
  deactivateUsers: z.boolean().optional(),
})

// Platform-wide access administration. systemPrisma throughout: granting a
// company access necessarily reaches across workspaces, which is why this sits
// behind catalogue.review rather than in org settings — an org admin must never
// be able to grant their own domain access.
export const GET = withAuthenticatedApi(async () => {
  const domains = await systemPrisma.platformAllowedDomain.findMany({
    select: {
      id: true,
      domain: true,
      note: true,
      createdAt: true,
      disabledAt: true,
      organizationId: true,
      organization: { select: { name: true, slug: true } },
    },
    orderBy: { domain: 'asc' },
    take: 500,
  })
  const organizations = await systemPrisma.organization.findMany({
    select: { id: true, name: true, slug: true, kind: true },
    orderBy: { name: 'asc' },
    take: 500,
  })
  return { success: true, domains, organizations, companyDomains: COMPANY_EMAIL_DOMAINS }
}, { permission: 'catalogue.review' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const data = postSchema.parse(await request.json())

  const domain = normalizeDomain(data.domain)
  if (!domain) {
    throw new ApiError(
      'Enter a plain domain such as customer.com — no wildcards, paths, or full email addresses.',
      400,
      'INVALID_DOMAIN',
    )
  }
  if (isPublicEmailProvider(domain)) {
    throw new ApiError(
      'That is a public email provider. Allowing it would let anyone with an email address into the platform.',
      400,
      'PUBLIC_EMAIL_PROVIDER',
    )
  }
  if ((COMPANY_EMAIL_DOMAINS as readonly string[]).includes(domain)) {
    throw new ApiError('That domain already has permanent access and does not need an entry.', 400, 'COMPANY_DOMAIN')
  }

  const organization = await systemPrisma.organization.findUnique({
    where: { id: data.organizationId },
    select: { id: true },
  })
  if (!organization) throw new ApiError('That workspace no longer exists.', 404, 'NOT_FOUND')

  const existing = await systemPrisma.platformAllowedDomain.findUnique({ where: { domain } })
  if (existing) {
    throw new ApiError('That domain is already listed. Re-enable it instead of adding it again.', 409, 'DOMAIN_EXISTS')
  }

  const created = await systemPrisma.platformAllowedDomain.create({
    data: {
      domain,
      organizationId: data.organizationId,
      note: data.note ?? '',
      addedByUserId: auth.dbUser.id,
    },
    select: { id: true, domain: true },
  })

  await recordAudit({
    organizationId: auth.organizationId,
    action: 'platform.domain_allowed',
    actorUserId: auth.dbUser.id,
    resourceType: 'platform_allowed_domain',
    resourceId: created.id,
    detail: { domain: created.domain, organizationId: data.organizationId },
  })

  return { success: true, domain: created }
}, { permission: 'catalogue.review' })

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const data = patchSchema.parse(await request.json())

  const row = await systemPrisma.platformAllowedDomain.findUnique({
    where: { id: data.id },
    select: { id: true, domain: true, organizationId: true },
  })
  if (!row) throw new ApiError('That domain entry no longer exists.', 404, 'NOT_FOUND')

  await systemPrisma.platformAllowedDomain.update({
    where: { id: data.id },
    data: { disabledAt: data.disabled ? new Date() : null },
  })

  // Disabling blocks NEW sign-ins at once, but live sessions survive until they
  // expire. Deactivating the domain's users is therefore a separate, explicit
  // choice rather than a silent side effect of a config edit.
  let deactivated = 0
  if (data.disabled && data.deactivateUsers) {
    const result = await systemPrisma.user.updateMany({
      where: { organizationId: row.organizationId, email: { endsWith: `@${row.domain}` }, isActive: true },
      data: { isActive: false },
    })
    deactivated = result.count
  }

  await recordAudit({
    organizationId: auth.organizationId,
    action: data.disabled ? 'platform.domain_disabled' : 'platform.domain_reenabled',
    actorUserId: auth.dbUser.id,
    resourceType: 'platform_allowed_domain',
    resourceId: row.id,
    detail: { domain: row.domain, deactivatedUsers: deactivated },
  })

  return { success: true, deactivated }
}, { permission: 'catalogue.review' })

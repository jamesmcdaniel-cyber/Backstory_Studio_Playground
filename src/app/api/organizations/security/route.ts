import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const [organization, domains] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: auth.organizationId },
      select: { mfaPolicy: true, ssoEnforced: true },
    }),
    prisma.organizationDomain.findMany({
      where: { organizationId: auth.organizationId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, domain: true, status: true, verificationToken: true, verifiedAt: true, createdAt: true },
    }),
  ])
  return { success: true, policy: organization, domains }
}, { permission: 'security.manage' })

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const body = z.object({
    mfaPolicy: z.enum(['optional', 'required']).optional(),
    ssoEnforced: z.boolean().optional(),
  }).refine((value) => value.mfaPolicy !== undefined || value.ssoEnforced !== undefined, 'Nothing to update.').parse(await request.json())

  if (body.ssoEnforced) {
    const verified = await prisma.organizationDomain.count({ where: { organizationId: auth.organizationId, status: 'verified' } })
    if (!verified) return Response.json({ success: false, error: 'Verify at least one domain before enforcing SSO.', code: 'DOMAIN_REQUIRED' }, { status: 400 })
  }
  const policy = await prisma.organization.update({
    where: { id: auth.organizationId },
    data: body,
    select: { mfaPolicy: true, ssoEnforced: true },
  })
  return { success: true, policy }
}, { permission: 'security.manage' })

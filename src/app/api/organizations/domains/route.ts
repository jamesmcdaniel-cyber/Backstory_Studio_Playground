import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { hashToken } from '@/lib/crypto/secrets'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

const domainSchema = z.string().trim().toLowerCase().max(253).regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { domain } = z.object({ domain: domainSchema }).parse(await request.json())
  const token = randomBytes(24).toString('base64url')
  try {
    const claimed = await prisma.organizationDomain.create({
      data: {
        organizationId: auth.organizationId,
        domain,
        verificationToken: token,
        verificationTokenHash: hashToken(token),
      },
      select: { id: true, domain: true, status: true, verificationToken: true },
    })
    return { success: true, domain: claimed, dns: { name: `_backstory-verification.${domain}`, value: `backstory-verification=${token}` } }
  } catch {
    throw new ApiError('That domain is already claimed by a workspace.', 409, 'DOMAIN_CLAIMED')
  }
}, { permission: 'security.manage' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { id } = z.object({ id: z.string().min(1) }).parse(await request.json())
  const result = await prisma.organizationDomain.deleteMany({ where: { id, organizationId: auth.organizationId } })
  if (!result.count) throw new ApiError('Domain not found.', 404, 'NOT_FOUND')
  const remaining = await prisma.organizationDomain.count({ where: { organizationId: auth.organizationId, status: 'verified' } })
  if (!remaining) await prisma.organization.update({ where: { id: auth.organizationId }, data: { ssoEnforced: false } })
  return { success: true }
}, { permission: 'security.manage' })

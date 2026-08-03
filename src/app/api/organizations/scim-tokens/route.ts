import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { hashToken } from '@/lib/crypto/secrets'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

export const GET = withAuthenticatedApi(async (_request, auth) => ({
  success: true,
  tokens: await prisma.scimToken.findMany({
    where: { organizationId: auth.organizationId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, prefix: true, lastUsedAt: true, expiresAt: true, revokedAt: true, createdAt: true },
  }),
}), { permission: 'security.manage' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { name, expiresAt } = z.object({ name: z.string().trim().min(1).max(80), expiresAt: z.coerce.date().optional() }).parse(await request.json())
  const plaintext = `bscim_${randomBytes(32).toString('base64url')}`
  const token = await prisma.scimToken.create({
    data: { organizationId: auth.organizationId, createdById: auth.dbUser.id, name, tokenHash: hashToken(plaintext), prefix: plaintext.slice(0, 12), expiresAt },
    select: { id: true, name: true, prefix: true, expiresAt: true, createdAt: true },
  })
  return { success: true, token: { ...token, secret: plaintext } }
}, { permission: 'security.manage' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { id } = z.object({ id: z.string().min(1) }).parse(await request.json())
  const result = await prisma.scimToken.updateMany({ where: { id, organizationId: auth.organizationId, revokedAt: null }, data: { revokedAt: new Date() } })
  if (!result.count) throw new ApiError('SCIM token not found.', 404, 'NOT_FOUND')
  return { success: true }
}, { permission: 'security.manage' })

import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { hashToken } from '@/lib/crypto/secrets'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordAudit } from '@/lib/audit'
import { recordCredentialGrant } from '@/lib/credentials/audit'

const scopes = z.enum(['flows:read', 'flows:write', 'flows:run'])

export const GET = withAuthenticatedApi(async (_request, auth) => ({
  success: true,
  keys: await prisma.apiKey.findMany({ where: { organizationId: auth.organizationId }, orderBy: { createdAt: 'desc' }, select: { id: true, name: true, prefix: true, scopes: true, lastUsedAt: true, expiresAt: true, revokedAt: true, createdAt: true } }),
}), { permission: 'api.manage' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const input = z.object({ name: z.string().trim().min(1).max(80), scopes: z.array(scopes).min(1), expiresAt: z.coerce.date().optional() }).parse(await request.json())
  const plaintext = `bsk_${randomBytes(32).toString('base64url')}`
  const key = await prisma.apiKey.create({
    data: { organizationId: auth.organizationId, userId: auth.dbUser.id, name: input.name, scopes: input.scopes, expiresAt: input.expiresAt, keyHash: hashToken(plaintext), prefix: plaintext.slice(0, 12) },
    select: { id: true, name: true, prefix: true, scopes: true, expiresAt: true, createdAt: true },
  })
  // An API key acts as its minter (it carries their permissions), so who minted
  // it and with which scopes is the whole authorization record for every call it
  // ever makes.
  await recordCredentialGrant({
    organizationId: auth.organizationId,
    kind: 'api_key',
    credentialId: key.id,
    provider: 'backstory_api',
    ownerUserId: auth.dbUser.id,
    actorUserId: auth.dbUser.id,
    scopes: input.scopes,
    method: 'api_key_mint',
  })
  return { success: true, key: { ...key, secret: plaintext } }
}, { permission: 'api.manage' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { id } = z.object({ id: z.string().min(1) }).parse(await request.json())
  const result = await prisma.apiKey.updateMany({ where: { id, organizationId: auth.organizationId, revokedAt: null }, data: { revokedAt: new Date() } })
  if (!result.count) throw new ApiError('API key not found.', 404, 'NOT_FOUND')
  await recordAudit({
    organizationId: auth.organizationId,
    action: 'credential.revoked',
    actorUserId: auth.dbUser.id,
    resourceType: 'api_key',
    resourceId: id,
    detail: { provider: 'backstory_api', reason: 'revoked_by_user' },
  })
  return { success: true }
}, { permission: 'api.manage' })

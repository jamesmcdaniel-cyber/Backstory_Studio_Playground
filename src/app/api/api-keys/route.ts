import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordAudit } from '@/lib/audit'
import { recordCredentialGrant } from '@/lib/credentials/audit'
import { resolveTokenExpiry } from '@/lib/credentials/lifetime'
import { mintClientCredentials } from '@/lib/public-api/client-credentials'

const scopes = z.enum(['flows:read', 'flows:write', 'flows:run'])

export const GET = withAuthenticatedApi(async (_request, auth) => ({
  success: true,
  keys: await prisma.apiKey.findMany({ where: { organizationId: auth.organizationId }, orderBy: { createdAt: 'desc' }, select: { id: true, name: true, prefix: true, clientId: true, scopes: true, lastUsedAt: true, expiresAt: true, revokedAt: true, createdAt: true } }),
}), { permission: 'api.manage' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const input = z.object({ name: z.string().trim().min(1).max(80), scopes: z.array(scopes).min(1), expiresAt: z.coerce.date().optional() }).parse(await request.json())
  // Always bounded: an API key acts as its minter, so an unbounded one grants
  // their permissions forever. Omitting expiresAt now yields the default
  // lifetime instead of no expiry at all.
  const expiresAt = resolveTokenExpiry(input.expiresAt)
  // A client-credentials PAIR, not a single token. The public half identifies
  // the key in a support thread or a log without anyone having to paste the
  // secret to say which key they mean — which is what the single-token scheme
  // forced, and how secrets end up in ticket systems.
  const { clientId, clientSecret, clientSecretHash } = mintClientCredentials()
  const key = await prisma.apiKey.create({
    data: {
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      name: input.name,
      scopes: input.scopes,
      expiresAt,
      clientId,
      keyHash: clientSecretHash,
      prefix: clientId.slice(0, 12),
    },
    select: { id: true, name: true, prefix: true, scopes: true, expiresAt: true, createdAt: true, clientId: true },
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
  // The secret is returned exactly once and never persisted in plaintext.
  return { success: true, key: { ...key, clientSecret, tokenUrl: '/api/v1/token' } }
}, { permission: 'api.manage' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { id } = z.object({ id: z.string().min(1) }).parse(await request.json())
  const result = await prisma.apiKey.updateMany({ where: { id, organizationId: auth.organizationId, revokedAt: null }, data: { revokedAt: new Date() } })
  if (!result.count) throw new ApiError('API key not found.', 404, 'NOT_FOUND')
  // Kill every access token minted from this key in the same breath. Without
  // this, revocation would be advisory for up to the token TTL — the exact
  // "can tokens be revoked immediately?" question, answered wrong.
  const killed = await prisma.apiAccessToken.updateMany({
    where: { apiKeyId: id, organizationId: auth.organizationId, revokedAt: null },
    data: { revokedAt: new Date() },
  })

  await recordAudit({
    organizationId: auth.organizationId,
    action: 'credential.revoked',
    actorUserId: auth.dbUser.id,
    resourceType: 'api_key',
    resourceId: id,
    detail: { provider: 'backstory_api', reason: 'revoked_by_user', accessTokensRevoked: killed.count },
  })
  return { success: true }
}, { permission: 'api.manage' })

import { hashToken } from '@/lib/crypto/secrets'
import { ACCESS_TOKEN_PREFIX } from '@/lib/public-api/client-credentials'
import { systemPrisma } from '@/lib/prisma'
import { rateLimit } from '@/lib/ratelimit'
import { recordSecurityEvent, recordTokenRejection, clientIp, requestPath } from '@/lib/security/events'

export type ApiScope = 'flows:read' | 'flows:write' | 'flows:run'
export type PublicApiContext = { organizationId: string; userId: string; keyId: string; scopes: ReadonlySet<string> }

export function publicApiJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

export async function authenticatePublicApi(request: Request, required: ApiScope): Promise<PublicApiContext | Response> {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')
  if (!match || match[1].length > 256) {
    await recordTokenRejection(request, { surface: 'public-api', reason: 'malformed_authorization' })
    return publicApiJson({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key.' } }, 401)
  }
  const presented = match[1]

  // Two credential shapes reach this line. A short-lived access token minted by
  // the client-credentials exchange is preferred — it expires in minutes, so a
  // leaked request log exposes something already dead. A long-lived key still
  // works, because breaking every existing integration to improve a credential
  // format is not a trade anyone would accept.
  const row = presented.startsWith(ACCESS_TOKEN_PREFIX)
    ? await resolveAccessToken(presented)
    : await resolveLongLivedKey(presented)

  if (!row || !row.userId) {
    await recordTokenRejection(request, { surface: 'public-api', reason: 'unknown_key' })
    return publicApiJson({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key.' } }, 401)
  }
  const user = await systemPrisma.user.findFirst({
    where: { id: row.userId, organizationId: row.organizationId, isActive: true },
    select: { id: true },
  })
  if (!user) {
    await recordTokenRejection(request, {
      surface: 'public-api',
      reason: 'owner_inactive',
      organizationId: row.organizationId,
    })
    return publicApiJson({ error: { code: 'UNAUTHORIZED', message: 'API key owner is no longer active.' } }, 401)
  }
  const scopes = new Set(Array.isArray(row.scopes) ? row.scopes.filter((scope): scope is string => typeof scope === 'string') : [])
  if (!scopes.has(required)) {
    // A valid key reaching for a scope it was not granted is the shape of a
    // stolen or over-reaching integration, so it is recorded as a denial rather
    // than a bad token.
    await recordSecurityEvent({
      kind: 'auth.forbidden',
      path: requestPath(request),
      method: request.method,
      ip: clientIp(request),
      userId: row.userId,
      organizationId: row.organizationId,
      subject: `api-key:${row.id}`,
      detail: { surface: 'public-api', required },
    })
    return publicApiJson({ error: { code: 'FORBIDDEN', message: `API key requires ${required}.` } }, 403)
  }
  const limited = await rateLimit(`public-api:${row.id}`, { limit: 600, windowMs: 60_000, failureMode: 'closed' })
  if (!limited.ok) {
    await recordSecurityEvent({
      kind: 'abuse.rate_limited',
      path: requestPath(request),
      method: request.method,
      ip: clientIp(request),
      userId: row.userId,
      organizationId: row.organizationId,
      subject: `api-key:${row.id}`,
      detail: { surface: 'public-api' },
    })
    return publicApiJson({ error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded.' } }, 429)
  }
  // Recorded against whichever record actually authenticated, so "when was this
  // key last used" stays true once callers move to the token exchange.
  if (row.accessTokenId) {
    await systemPrisma.apiAccessToken.update({ where: { id: row.accessTokenId }, data: { lastUsedAt: new Date() } })
  }
  await systemPrisma.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
  return { organizationId: row.organizationId, userId: row.userId, keyId: row.id, scopes }
}

interface ResolvedApiCredential {
  id: string
  organizationId: string
  userId: string | null
  scopes: unknown
  /** Set when a short-lived token authenticated, rather than the key itself. */
  accessTokenId?: string
}

async function resolveLongLivedKey(presented: string): Promise<ResolvedApiCredential | null> {
  // systemPrisma: key digest resolves the tenant before tenant context exists.
  return systemPrisma.apiKey.findFirst({
    where: {
      keyHash: hashToken(presented),
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { id: true, organizationId: true, userId: true, scopes: true },
  })
}

/**
 * Resolve a short-lived access token to the key that issued it.
 *
 * The token's OWN scopes are returned, not the key's: they were snapshotted at
 * issue so a token can never outrank its key, and narrowing the key afterwards
 * cannot widen a token already in flight.
 *
 * The key's revocation is re-checked here rather than relied on through the
 * cascade — revoking a key sets revokedAt instead of deleting the row, so
 * tokens minted from it survive the FK and must be refused explicitly.
 */
async function resolveAccessToken(presented: string): Promise<ResolvedApiCredential | null> {
  const token = await systemPrisma.apiAccessToken.findFirst({
    where: {
      tokenHash: hashToken(presented),
      revokedAt: null,
      expiresAt: { gt: new Date() },
      apiKey: {
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    },
    select: {
      id: true,
      scopes: true,
      apiKey: { select: { id: true, organizationId: true, userId: true } },
    },
  })
  if (!token) return null

  return {
    id: token.apiKey.id,
    organizationId: token.apiKey.organizationId,
    userId: token.apiKey.userId,
    scopes: token.scopes,
    accessTokenId: token.id,
  }
}

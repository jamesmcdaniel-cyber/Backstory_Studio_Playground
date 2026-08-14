import { hashToken } from '@/lib/crypto/secrets'
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
  const row = await systemPrisma.apiKey.findFirst({
    // systemPrisma: key digest resolves the tenant before tenant context exists.
    where: { keyHash: hashToken(match[1]), revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    select: { id: true, organizationId: true, userId: true, scopes: true },
  })
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
  await systemPrisma.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
  return { organizationId: row.organizationId, userId: row.userId, keyId: row.id, scopes }
}

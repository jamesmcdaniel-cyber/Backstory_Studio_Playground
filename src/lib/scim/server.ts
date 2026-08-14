import { createClient } from '@supabase/supabase-js'
import type { UserRole } from '@prisma/client'
import { hashToken } from '@/lib/crypto/secrets'
import { systemPrisma } from '@/lib/prisma'
import { rateLimit } from '@/lib/ratelimit'
import { clientIp, recordSecurityEvent, recordTokenRejection, requestPath } from '@/lib/security/events'

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User'
export const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse'
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error'

export type ScimContext = { organizationId: string; tokenId: string }

export function scimJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'content-type': 'application/scim+json', 'cache-control': 'no-store' } })
}

export function scimError(detail: string, status: number): Response {
  return scimJson({ schemas: [SCIM_ERROR_SCHEMA], status: String(status), detail }, status)
}

export async function authenticateScim(request: Request): Promise<ScimContext | Response> {
  const authorization = request.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(authorization)
  if (!match || match[1].length > 256) {
    await recordTokenRejection(request, { surface: 'scim', reason: 'malformed_authorization' })
    return scimError('Invalid bearer token.', 401)
  }
  const token = await systemPrisma.scimToken.findFirst({
    // systemPrisma: the bearer digest resolves the tenant before a tenant
    // context exists. Only active, unexpired credentials are accepted.
    where: { tokenHash: hashToken(match[1]), revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    select: { id: true, organizationId: true },
  })
  if (!token) {
    await recordTokenRejection(request, { surface: 'scim', reason: 'unknown_token' })
    return scimError('Invalid bearer token.', 401)
  }
  const limited = await rateLimit(`scim:${token.id}`, { limit: 600, windowMs: 60_000, failureMode: 'closed' })
  if (!limited.ok) {
    await recordSecurityEvent({
      kind: 'abuse.rate_limited',
      path: requestPath(request),
      method: request.method,
      ip: clientIp(request),
      organizationId: token.organizationId,
      subject: `scim:${token.id}`,
      detail: { surface: 'scim' },
    })
    return scimError('Rate limit exceeded.', 429)
  }
  await systemPrisma.scimToken.update({ where: { id: token.id }, data: { lastUsedAt: new Date() } })
  return { organizationId: token.organizationId, tokenId: token.id }
}

export function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SCIM requires SUPABASE_SERVICE_ROLE_KEY.')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }).auth.admin
}

export function roleOf(value: unknown): UserRole {
  const normalized = typeof value === 'string' ? value.toUpperCase() : 'USER'
  return (['OWNER', 'ADMIN', 'USER', 'VIEWER'].includes(normalized) ? normalized : 'USER') as UserRole
}

export function scimUser(user: { id: string; scimExternalId: string | null; email: string | null; name: string | null; isActive: boolean; role: UserRole; createdAt: Date; updatedAt: Date }) {
  const [givenName = '', ...family] = (user.name ?? '').trim().split(/\s+/)
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: user.id,
    externalId: user.scimExternalId ?? undefined,
    userName: user.email ?? '',
    active: user.isActive,
    displayName: user.name ?? user.email ?? '',
    name: { givenName, familyName: family.join(' ') },
    emails: user.email ? [{ value: user.email, primary: true, type: 'work' }] : [],
    roles: [{ value: user.role }],
    meta: { resourceType: 'User', created: user.createdAt.toISOString(), lastModified: user.updatedAt.toISOString(), location: `/api/scim/v2/Users/${user.id}` },
  }
}

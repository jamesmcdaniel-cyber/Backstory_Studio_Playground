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

/**
 * Pre-auth admission gate, per client IP.
 *
 * The per-token budget below is the steady-state limit, but it only exists
 * AFTER a token has resolved — which means every unauthenticated caller was
 * buying an unbounded stream of digest lookups against `scim_tokens`. This gate
 * runs before any database work, so brute force and plain flooding are capped
 * whether or not the caller holds a credential. It is generous enough that a
 * real IdP (one shared egress IP, several tokens) never notices.
 *
 * Fails closed: SCIM is provisioning, not a user-facing surface — a paused sync
 * retries, an uncapped pre-auth endpoint does not self-correct.
 */
export const SCIM_ADMISSION_BUDGET = { limit: 1_200, windowMs: 60_000, failureMode: 'closed' } as const

function scimClientIp(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown'
}

/** The admission key for a caller — exported so tests can drive the budget. */
export function scimAdmissionKey(request: Request): string {
  return `scim-ip:${scimClientIp(request)}`
}

export async function authenticateScim(request: Request): Promise<ScimContext | Response> {
  const admitted = await rateLimit(scimAdmissionKey(request), SCIM_ADMISSION_BUDGET)
  if (!admitted.ok) return scimError('Rate limit exceeded.', 429)
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

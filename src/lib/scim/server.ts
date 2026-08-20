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

/**
 * Thrown by supabaseAdmin() when the service-role key is absent.
 *
 * A named type rather than a bare Error because callers need to TELL THE
 * DIFFERENCE: this is a misconfigured deployment, not a failed operation, and
 * the two deserve different words in front of an operator. It is also thrown
 * SYNCHRONOUSLY, so `supabaseAdmin().someCall().catch(...)` cannot see it —
 * acquire the client on its own line.
 *
 * SUPABASE_SERVICE_ROLE_KEY is deliberately not in env.ts's boot-required list,
 * so a deploy without it starts fine and every surface that needs it (SCIM,
 * stored files, run streaming, the operator console's account actions) fails
 * here instead.
 */
export class SupabaseUnconfiguredError extends Error {
  constructor() {
    super('SUPABASE_SERVICE_ROLE_KEY is not set, so the Supabase admin API is unavailable.')
    this.name = 'SupabaseUnconfiguredError'
  }
}

/**
 * Is this Supabase error "that identity does not exist" rather than a failure?
 *
 * Identities deleted straight out of the Supabase dashboard leave our user rows
 * pointing at nothing, and every admin call on one comes back 404. Whether that
 * satisfies the caller's intent or defeats it depends on the call, but it is
 * never the transient outage a bare error would imply.
 *
 * Matched on the code rather than the message so a copy edit upstream cannot
 * turn a handled state back into an outage; the bare 404 covers older GoTrue
 * builds that sent no error_code.
 */
export function isIdentityGone(error: unknown): boolean {
  const value = error as { code?: unknown; status?: unknown } | null
  return value?.code === 'user_not_found' || value?.status === 404
}

export function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new SupabaseUnconfiguredError()
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

/** GoTrue's per-page maximum for the admin user listing. */
const IDENTITY_PAGE_SIZE = 1000
/** ~20k identities. Beyond this the sweep is abandoned rather than trusted. */
const IDENTITY_PAGE_LIMIT = 20

/**
 * The ban/delete state GoTrue reports for an identity.
 *
 * Neither field is on @supabase/auth-js's `User` type — `banned_until` is
 * returned by the admin listing but has never been declared, and `deleted_at`
 * is declared but not on every version. So the sweep reads them off the raw
 * object through this shape rather than trusting the SDK's type, which would
 * silently narrow them away.
 */
type IdentityState = { banned_until?: string | null; deleted_at?: string | null }

/**
 * Whether Supabase will refuse to sign this identity in.
 *
 * Banning is how deactivation is expressed on both paths — the console's own
 * deactivate action sets `ban_duration`, and the Supabase dashboard's "Ban
 * user" does the same thing — so a banned identity is a deactivated account,
 * not merely a flagged one.
 *
 * Pure and exported so the rule is unit-testable without a Supabase project.
 *
 * An UNPARSEABLE ban stamp counts as banned. Supabase set that value for a
 * reason, and the two ways to be wrong are not symmetric: reading it as "not
 * banned" leaves a revoked account listed and treated as healthy, while reading
 * it as banned merely hides a row an operator can still reveal.
 */
export function identityDisabled(identity: IdentityState, now: Date): boolean {
  if (identity.deleted_at) return true
  const until = identity.banned_until
  // GoTrue clears a ban to null; 'none' is the value the WRITE side uses, and
  // is accepted here so an echoed request body can never read as a ban.
  if (!until || until === 'none') return false
  const at = Date.parse(until)
  return Number.isNaN(at) || at > now.getTime()
}

/** What one sweep of the Supabase identity store found. */
export type IdentitySweep = {
  /** Every identity id Supabase returned, disabled ones included. */
  present: Set<string>
  /**
   * Those Supabase will no longer sign in — banned or soft-deleted. They are
   * still returned by the admin listing, so without this pass they are
   * indistinguishable from a healthy account.
   */
  disabled: Set<string>
}

/**
 * Every identity Supabase currently holds, split by whether it can still sign
 * in — or null when the answer cannot be trusted.
 *
 * null, never an empty set, on EVERY failure path: unconfigured, an API error,
 * or more pages than the cap. Callers use this to mark our own rows as
 * orphaned, so a partial sweep would report live accounts as deleted. That is
 * far worse than "unknown": it invites an operator to delete people who are
 * still using the product, and the deletion is the one action they cannot undo.
 */
export async function supabaseIdentitySweep(now: Date = new Date()): Promise<IdentitySweep | null> {
  let admin: ReturnType<typeof supabaseAdmin>
  try {
    admin = supabaseAdmin()
  } catch {
    return null
  }
  const present = new Set<string>()
  const disabled = new Set<string>()
  for (let page = 1; page <= IDENTITY_PAGE_LIMIT; page += 1) {
    const { data, error } = await admin
      .listUsers({ page, perPage: IDENTITY_PAGE_SIZE })
      .catch((cause: unknown) => ({ data: null, error: cause }))
    if (error || !data) return null
    for (const identity of data.users) {
      present.add(identity.id)
      if (identityDisabled(identity as IdentityState, now)) disabled.add(identity.id)
    }
    // A short page is the last page. Anything else means another round trip.
    if (data.users.length < IDENTITY_PAGE_SIZE) return { present, disabled }
  }
  return null
}

/**
 * Ids only, for callers that just need "does this identity still exist".
 * Kept as a thin wrapper so the orphan check reads the same as it always has.
 */
export async function liveSupabaseIdentities(): Promise<Set<string> | null> {
  return (await supabaseIdentitySweep())?.present ?? null
}

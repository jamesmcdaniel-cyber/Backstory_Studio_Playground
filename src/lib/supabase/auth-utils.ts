import type { User } from '@supabase/supabase-js'
import { prisma } from '@/lib/prisma'
import { createClient } from '@/lib/supabase/server'

function findDbUser(supabaseId: string) {
  return prisma.user.findFirst({
    where: { supabaseId, isActive: true },
    include: { organization: true },
  })
}

// Per-instance cache of the supabaseId → app user (+org) lookup. This query
// runs on EVERY authenticated API request via requireAuthContext; the row
// changes rarely (role/org edits), so a short TTL removes a DB round-trip from
// the hot path on warm instances while bounding staleness to one minute.
type DbUserRow = Awaited<ReturnType<typeof findDbUser>>
const DB_USER_TTL_MS = 60_000
const dbUserCache = new Map<string, { row: NonNullable<DbUserRow>; ts: number }>()

async function findDbUserCached(supabaseId: string): Promise<DbUserRow> {
  const hit = dbUserCache.get(supabaseId)
  if (hit && Date.now() - hit.ts < DB_USER_TTL_MS) return hit.row
  const row = await findDbUser(supabaseId)
  if (row) dbUserCache.set(supabaseId, { row, ts: Date.now() })
  else dbUserCache.delete(supabaseId)
  return row
}

/**
 * Drop the cached auth row for a user so the next request re-reads it. Call
 * after mutating a user's org/role out-of-band (e.g. accepting an invitation),
 * or the stale cache would keep them in their old workspace for up to the TTL.
 */
export function invalidateAuthCache(supabaseId: string) {
  dbUserCache.delete(supabaseId)
}

/**
 * Recovery path for platform staff: addresses listed in PLATFORM_STAFF_EMAILS
 * are promoted to reviewer on sign-in, and their workspace is marked internal.
 * Idempotent, and a no-op for everyone else. Once one reviewer exists, further
 * grants happen in /admin/catalogue — this env var only has to solve the
 * bootstrap problem of granting the FIRST one, since nobody can grant review
 * rights before a reviewer exists.
 */
async function applyStaffBootstrap(dbUser: NonNullable<DbUserRow>): Promise<NonNullable<DbUserRow>> {
  const allowlist = (process.env.PLATFORM_STAFF_EMAILS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
  const email = dbUser.email?.trim().toLowerCase()
  if (!email || !allowlist.includes(email)) return dbUser
  if (dbUser.platformRole === 'reviewer' && dbUser.organization?.kind === 'internal') return dbUser

  const updated = await prisma.user.update({
    where: { id: dbUser.id },
    data: { platformRole: 'reviewer' },
    include: { organization: true },
  })
  // Drop the cached row in BOTH branches: the cache is keyed on supabaseId and
  // holds the pre-promotion user for up to a minute otherwise, so the first
  // request after promotion would still resolve customer-tier permissions.
  invalidateAuthCache(dbUser.supabaseId)

  if (updated.organizationId && updated.organization && updated.organization.kind !== 'internal') {
    await prisma.organization.update({
      where: { id: updated.organizationId },
      data: { kind: 'internal' },
    })
    return { ...updated, organization: { ...updated.organization, kind: 'internal' } }
  }
  return updated
}

// Self-healing bootstrap: the handle_new_user Postgres trigger is optional
// infra that may never be installed, so provision the app user + organization
// on first authenticated request when they don't exist yet.
async function provisionUser(user: User) {
  const meta = (user.user_metadata || {}) as Record<string, unknown>
  const emailPrefix = (user.email || 'user').split('@')[0]
  const metaString = (key: string) => (typeof meta[key] === 'string' ? (meta[key] as string) : '')
  const orgName = metaString('organization_name') || metaString('full_name') || emailPrefix
  const name = metaString('full_name') || emailPrefix
  const inviteEmail = user.email?.trim().toLowerCase() || null

  try {
    return await prisma.$transaction(async (tx) => {
      // If this email was invited, join that workspace (with the invited role)
      // instead of spawning a fresh solo org — no orphaned workspace, and the
      // invite is consumed atomically with the join.
      const invite = inviteEmail
        ? await tx.invitation.findFirst({
            where: { email: inviteEmail, status: 'PENDING', expiresAt: { gt: new Date() } },
            orderBy: { createdAt: 'desc' },
          })
        : null

      const organizationId = invite
        ? invite.organizationId
        : (await tx.organization.create({ data: { name: orgName, slug: `org-${user.id}` } })).id

      const created = await tx.user.create({
        data: {
          supabaseId: user.id,
          email: user.email ?? null,
          name,
          role: invite ? (invite.role === 'ADMIN' ? 'ADMIN' : 'USER') : 'ADMIN',
          organizationId,
        },
        include: { organization: true },
      })

      if (invite) {
        await tx.invitation.update({
          where: { id: invite.id },
          data: { status: 'ACCEPTED', acceptedByUserId: created.id, acceptedAt: new Date() },
        })
      }
      return created
    })
  } catch {
    // Lost a race (unique supabaseId/slug) or the trigger created it
    // concurrently — re-read whatever now exists.
    return findDbUser(user.id)
  }
}

export async function getAuthWithUser() {
  const supabase = await createClient()

  // Prefer getClaims(): on projects with asymmetric JWT signing keys the token
  // verifies LOCALLY against a cached JWKS — zero network on the auth hot path.
  // On legacy symmetric-key projects supabase-js falls back to a server check
  // itself, so behavior (and cost) is never worse than getUser(). Consumers
  // only use identity fields (id/email/user_metadata), all present in claims.
  let user: User | null = null
  try {
    const { data } = await supabase.auth.getClaims()
    const claims = data?.claims
    if (claims?.sub) {
      user = {
        id: claims.sub,
        email: typeof claims.email === 'string' ? claims.email : undefined,
        user_metadata: (claims.user_metadata as Record<string, unknown> | undefined) ?? {},
        app_metadata: (claims.app_metadata as Record<string, unknown> | undefined) ?? {},
        aud: typeof claims.aud === 'string' ? claims.aud : 'authenticated',
        created_at: '',
      } as User
    }
  } catch {
    // Fall through to getUser below (e.g. token needs a refresh round-trip).
  }

  if (!user) {
    const { data, error } = await supabase.auth.getUser()
    if (error || !data.user) return null
    user = data.user
  }

  const resolved = (await findDbUserCached(user.id)) ?? (await provisionUser(user))
  const dbUser = resolved ? await applyStaffBootstrap(resolved) : resolved

  return {
    user,
    userId: user.id,
    dbUser,
    organizationId: dbUser?.organizationId ?? null,
  }
}

export async function requireAuth() {
  const auth = await getAuthWithUser()
  return auth?.dbUser ? auth : null
}

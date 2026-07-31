import type { User } from '@supabase/supabase-js'
import { prisma } from '@/lib/prisma'
import { createClient } from '@/lib/supabase/server'

function findDbUser(supabaseId: string) {
  return prisma.user.findFirst({
    where: { supabaseId, isActive: true },
    include: { organization: true },
  })
}

type DbUserRow = Awaited<ReturnType<typeof findDbUser>>

/**
 * This lookup is deliberately NOT cached.
 *
 * It used to be memoized per process for 60s to save a round-trip on the auth
 * hot path. Every field it returns is an authority field — `organizationId`,
 * `role`, `platformRole`, `isActive` — so there is no subset that is safe to
 * serve stale, and a module-level Map is per-instance: an invalidation on the
 * lambda that handled the mutation is invisible to every other warm instance.
 * That made member removal, role demotion, and org transfer take effect on one
 * instance and be ignored by the rest for up to a minute.
 *
 * The replacement is one lookup on a unique index (`users.supabaseId`) per
 * authenticated request. It is a smaller cost than the class of bug it removes,
 * and it is the ONLY thing standing between a revoked member and their old
 * workspace until RLS lands. If this ever shows up in a profile, the fix is a
 * shared-backend cache with explicit invalidation (src/lib/cache.ts), never a
 * per-instance one.
 */

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

  const resolved = (await findDbUser(user.id)) ?? (await provisionUser(user))
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

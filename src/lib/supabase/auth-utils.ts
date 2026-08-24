import type { User } from '@supabase/supabase-js'
import { prisma, systemPrisma } from '@/lib/prisma'
import { createClient } from '@/lib/supabase/server'
import { allowedDomainOrg, isAllowedEmail, isDomainAccessRevoked } from '@/lib/auth/allowed-domain'
import { amrMethods } from '@/lib/auth/enterprise-policy'
import { normalizeStaffEmail, staffBootstrapAllowlist } from '@/lib/catalogue/staff-emails'
import { isPlatformOwnerEmail } from '@/lib/authz/platform-owner'
import { isCustomerEdition } from '@/lib/edition'
import { readCachedAuthUser, writeCachedAuthUser } from '@/lib/server/auth-cache'

function findDbUser(supabaseId: string) {
  return prisma.user.findFirst({
    where: { supabaseId, isActive: true },
    include: { organization: true },
  })
}

/**
 * The row for this identity WITHOUT the isActive filter, so a deactivated
 * account can be told apart from one that was never provisioned. Only
 * resolveAuthUser may use it — every other reader wants findDbUser, which
 * refuses inactive rows.
 */
async function findUserRow(supabaseId: string) {
  // The one query every authenticated request makes. Served from the shared
  // cache when it is warm, and evicted globally by any write to this row — see
  // src/lib/server/auth-cache.ts for why that is the only acceptable shape and
  // what the residual staleness is. A miss, or no cache backend at all, falls
  // straight through to the unique index.
  const cached = await readCachedAuthUser<Awaited<ReturnType<typeof readUserRow>>>(supabaseId)
  if (cached) return cached
  const row = await readUserRow(supabaseId)
  if (row) await writeCachedAuthUser(supabaseId, row.id, row)
  return row
}

function readUserRow(supabaseId: string) {
  return prisma.user.findUnique({
    where: { supabaseId },
    include: { organization: true },
  })
}

type DbUserRow = Awaited<ReturnType<typeof findDbUser>>

/**
 * This lookup IS cached — in the shared backend, never per instance.
 *
 * The history matters, because the obvious version of this is a live bug. It
 * was once memoized in a module-level Map for 60s. Every field it returns is an
 * authority field (organizationId, role, platformRole, isActive), and a
 * per-instance Map cannot be invalidated across instances — so member removal
 * and role demotion took effect on the one lambda that handled the mutation and
 * were ignored by every other warm one for up to a minute. That cache was
 * deleted, and the comment left here specified its only acceptable replacement:
 * a shared backend with explicit invalidation.
 *
 * src/lib/server/auth-cache.ts is that, with the invalidation moved off the
 * call sites and into the Prisma extension — because two member routes
 * forgetting to invalidate is how the original bug reached production in the
 * first place. Read that file before changing anything here.
 */

/**
 * Recovery path for platform staff: addresses in the bootstrap allowlist
 * (hardcoded platform-admin defaults ∪ PLATFORM_STAFF_EMAILS) are promoted to
 * reviewer on sign-in, and their workspace is marked internal. Idempotent, and
 * a no-op for everyone else. Once one reviewer exists, further grants happen
 * in the Reviews console — this allowlist only has to solve the bootstrap
 * problem of granting the FIRST one, since nobody can grant review rights
 * before a reviewer exists.
 */
export async function applyStaffBootstrap(dbUser: NonNullable<DbUserRow>): Promise<NonNullable<DbUserRow>> {
  // The customer edition has no platform staff. This is a hard no-op rather
  // than a matter of leaving PLATFORM_STAFF_EMAILS unset, because this function
  // grants platformRole 'reviewer' AND flips the workspace to kind 'internal' —
  // which resolvePermissions turns into catalogue.review/publish/takedown, i.e.
  // the whole operator console. An env var alone would leave that one config
  // mistake away in a customer deploy.
  if (isCustomerEdition()) return dbUser

  const email = normalizeStaffEmail(dbUser.email)
  if (!email || !staffBootstrapAllowlist().has(email)) return dbUser
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

/**
 * Platform owner bootstrap: the owner identities (src/lib/authz/platform-owner)
 * always resolve to an active OWNER with a workspace, in EVERY edition. This
 * runs on the sign-in path so no database edit, sync job, or admin action can
 * leave the owner locked out: the role self-heals on the next request. If the
 * owner's workspace was deleted (their user row survives — the users-table
 * trigger forbids deleting it, so teardown detaches it instead), a fresh one
 * is attached here.
 */
async function applyOwnerBootstrap(dbUser: NonNullable<DbUserRow>): Promise<NonNullable<DbUserRow>> {
  if (!isPlatformOwnerEmail(dbUser.email)) return dbUser
  const needsRole = dbUser.role !== 'OWNER'
  const needsOrg = !dbUser.organizationId
  if (!needsRole && !needsOrg) return dbUser

  // systemPrisma: pre-request identity repair — there is no tenant context yet
  // when the owner's workspace is being (re)attached.
  const organizationId = needsOrg
    ? (await systemPrisma.organization.upsert({
        where: { slug: `org-${dbUser.supabaseId}` },
        update: {},
        create: { name: dbUser.name ?? 'Owner workspace', slug: `org-${dbUser.supabaseId}`, kind: 'internal' },
      })).id
    : dbUser.organizationId

  return systemPrisma.user.update({
    where: { id: dbUser.id },
    data: { role: 'OWNER', isActive: true, organizationId },
    include: { organization: true },
  })
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
  // An allowed customer domain routes every user into ONE shared workspace
  // rather than spawning a solo org each. Resolved outside the transaction: it
  // is a read against a table the transaction never writes.
  const domainOrgId = await allowedDomainOrg(user.email)

  try {
    // systemPrisma: this pre-membership bootstrap must discover a pending
    // invitation by verified email before the user's destination org is known.
    // The transaction then consumes only that exact invitation.
    return await systemPrisma.$transaction(async (tx) => {
      // If this email was invited, join that workspace (with the invited role)
      // instead of spawning a fresh solo org — no orphaned workspace, and the
      // invite is consumed atomically with the join.
      const invite = inviteEmail
        ? await tx.invitation.findFirst({
            where: { email: inviteEmail, status: 'PENDING', expiresAt: { gt: new Date() } },
            orderBy: { createdAt: 'desc' },
          })
        : null

      // Precedence: an explicit invitation beats the domain rule (someone
      // invited to a specific workspace goes there), which beats a fresh org.
      const organizationId = invite
        ? invite.organizationId
        : domainOrgId
          ? domainOrgId
          : (await tx.organization.create({ data: { name: orgName, slug: `org-${user.id}` } })).id

      const created = await tx.user.create({
        data: {
          supabaseId: user.id,
          email: user.email ?? null,
          name,
          // Fresh solo workspaces make their founder ADMIN. Joining an EXISTING
          // workspace — by invite or by domain rule — must not, or the first
          // customer to sign in would own the shared org. The platform owner
          // identity always lands as OWNER regardless of how they arrive.
          role: isPlatformOwnerEmail(inviteEmail)
            ? 'OWNER'
            : invite ? (invite.role === 'ADMIN' ? 'ADMIN' : 'USER') : domainOrgId ? 'USER' : 'ADMIN',
          organizationId,
        },
        include: { organization: true },
      })

      if (invite) {
        await tx.invitation.update({
          where: { id: invite.id, organizationId: invite.organizationId },
          data: { status: 'ACCEPTED', acceptedByUserId: created.id, acceptedAt: new Date() },
        })
      }

      // A super-admin grant addressed to this email (added in the Reviews
      // console before the person ever signed in) is claimed here: the account
      // starts as reviewer. A fresh solo workspace is marked internal so the
      // rights resolve immediately; a workspace they JOINED (invite or domain
      // rule) keeps its kind — flipping a whole existing org's tier is a
      // decision for the console, not a signup side effect.
      if (inviteEmail && !isCustomerEdition()) {
        const staffGrant = await tx.platformStaffEmail.findUnique({ where: { email: inviteEmail } })
        if (staffGrant && !staffGrant.claimedAt) {
          const promoted = await tx.user.update({
            where: { id: created.id },
            data: { platformRole: 'reviewer' },
            include: { organization: true },
          })
          await tx.platformStaffEmail.update({
            where: { id: staffGrant.id },
            data: { claimedAt: new Date(), claimedByUserId: created.id },
          })
          if (!invite && !domainOrgId && promoted.organization && promoted.organization.kind !== 'internal') {
            await tx.organization.update({ where: { id: organizationId }, data: { kind: 'internal' } })
            return { ...promoted, organization: { ...promoted.organization, kind: 'internal' } }
          }
          return promoted
        }
      }
      return created
    })
  } catch {
    // Lost a race (unique supabaseId/slug) or the trigger created it
    // concurrently — re-read whatever now exists.
    return findDbUser(user.id)
  }
}

export type ResolvedAuthUser = { dbUser: DbUserRow; deactivated: boolean; accessRevoked: boolean }

/**
 * Resolve the application user behind an already-verified Supabase identity.
 *
 * A deactivated row short-circuits: no provisioning, no bootstrap, null dbUser
 * and `deactivated` true.
 *
 * Skipping provisioning is the point. Deactivation was already enforced — the
 * findDbUser lookup filters isActive, so the fall-through to provisionUser hit
 * the unique supabaseId and rolled back — but only by accident of a constraint
 * violation, which cost a full write transaction (org create included) on EVERY
 * request from a banned account and surfaced as the same "Organization access
 * required" a user with no workspace gets. Now the state is named, so
 * requireAuthContext can answer ACCOUNT_DEACTIVATED and the write never starts.
 *
 * The platform owner can never reach that branch: the users-table trigger
 * (20260806090000_platform_owner_protection) refuses to set isActive false on
 * an owner row and forces it true on insert.
 *
 * PLATFORM ADMISSION IS ENFORCED HERE, not only at the OAuth callback.
 *
 * It used to live solely in src/app/auth/callback/route.ts, which meant it
 * governed exactly one way in. `signInWithPassword` mints its session against
 * Supabase directly and never touches that callback — and passwords are a live
 * credential in this product (Settings sets one, the admin console mails
 * resets), so the gate was reachable-around rather than theoretical. Two
 * consequences, both closed below: a non-allowlisted address could be
 * provisioned a fresh ADMIN workspace, and members of a domain whose access had
 * been REVOKED kept minting new sessions forever.
 *
 * The two halves are asked where each is the correct question (see
 * src/lib/auth/allowed-domain.ts): the full gate at provisioning, the revocation
 * dimension on every request after it. Both fail closed to `dbUser: null`, so
 * the routes that call `getAuthWithUser` directly rather than through
 * `requireAuthContext` (peopleai/status, peopleai/connect) inherit the refusal
 * as the 401 they already return for an absent user.
 */
export async function resolveAuthUser(user: User): Promise<ResolvedAuthUser> {
  const existing = await findUserRow(user.id)
  if (existing && !existing.isActive) return { dbUser: null, deactivated: true, accessRevoked: false }

  // Existing account: the revocation dimension only. Asking the full question
  // would lock out every externally invited person, whose admitting invitation
  // was consumed the moment they were provisioned.
  if (existing) {
    if (await isDomainAccessRevoked(existing.email)) {
      return { dbUser: null, deactivated: false, accessRevoked: true }
    }
  } else if (!(await isAllowedEmail(user.email))) {
    // No row yet, so this is provisioning — the same moment, and the same
    // question, as the OAuth callback. Refused BEFORE provisionUser runs, so a
    // rejected identity never creates an organization or a user row.
    return { dbUser: null, deactivated: false, accessRevoked: true }
  }

  const resolved = existing ?? (await provisionUser(user))
  const bootstrapped = resolved ? await applyOwnerBootstrap(resolved) : resolved
  const dbUser = bootstrapped ? await applyStaffBootstrap(bootstrapped) : bootstrapped
  return { dbUser, deactivated: false, accessRevoked: false }
}

export async function getAuthWithUser() {
  const supabase = await createClient()

  // Prefer getClaims(): on projects with asymmetric JWT signing keys the token
  // verifies LOCALLY against a cached JWKS — zero network on the auth hot path.
  // On legacy symmetric-key projects supabase-js falls back to a server check
  // itself, so behavior (and cost) is never worse than getUser(). Consumers
  // only use identity fields (id/email/user_metadata), all present in claims.
  let user: User | null = null
  let assuranceLevel: string | null = null
  let authMethods: string[] = []
  try {
    const { data } = await supabase.auth.getClaims()
    const claims = data?.claims
    if (claims?.sub) {
      assuranceLevel = typeof claims.aal === 'string' ? claims.aal : null
      authMethods = amrMethods(claims.amr)
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
    authMethods = [
      ...(typeof user.app_metadata?.provider === 'string' ? [user.app_metadata.provider] : []),
      ...(Array.isArray(user.app_metadata?.providers) ? user.app_metadata.providers.filter((value): value is string => typeof value === 'string') : []),
    ]
    assuranceLevel = user.factors?.some((factor) => factor.status === 'verified') ? 'aal2' : 'aal1'
  }

  const { dbUser, deactivated, accessRevoked } = await resolveAuthUser(user)

  return {
    user,
    userId: user.id,
    dbUser,
    deactivated,
    accessRevoked,
    organizationId: dbUser?.organizationId ?? null,
    assuranceLevel,
    authMethods,
  }
}

export async function requireAuth() {
  const auth = await getAuthWithUser()
  return auth?.dbUser ? auth : null
}

/** Test-only seam: provisioning is otherwise reached solely via getAuthWithUser. */
export const provisionUserForTest = provisionUser

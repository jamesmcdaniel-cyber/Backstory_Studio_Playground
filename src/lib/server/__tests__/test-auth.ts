import crypto from 'node:crypto'
import { setTestAuthContext } from '../auth'
import type { AuthContext } from '../auth'
import { resolvePermissions } from '@/lib/authz/permissions'
import type { UserRole } from '@prisma/client'
import { DEFAULT_FEATURES } from '@/lib/authz/features'

export interface SeedOverrides {
  /** 'customer' (default) | 'partner' | 'internal' */
  orgKind?: string
  role?: UserRole
  platformRole?: string | null
  /**
   * Explicit creation timestamp, only ever needed by INTERNAL fixtures.
   *
   * resolveInternalOrgId picks the OLDEST internal org, so a test that seeds one
   * can silently become "the platform" for whichever other test file is running
   * concurrently. Dating a fixture far in the future keeps it out of that
   * selection while leaving its permissions exactly as they are.
   */
  orgCreatedAt?: Date
}

/** Seed an org + active user and return an AuthContext bound to them. */
export async function seedTestOrg(
  prisma: any,
  overrides: SeedOverrides = {},
): Promise<{ organizationId: string; userId: string; auth: AuthContext; cleanup: () => Promise<void> }> {
  const org = await prisma.organization.create({
    data: {
      name: 'Smoke',
      slug: `smoke-${crypto.randomUUID()}`,
      kind: overrides.orgKind ?? 'customer',
      ...(overrides.orgCreatedAt ? { createdAt: overrides.orgCreatedAt } : {}),
    },
  })
  const user = await prisma.user.create({
    data: {
      supabaseId: crypto.randomUUID(),
      organizationId: org.id,
      isActive: true,
      // ADMIN rather than Prisma's USER default: the smoke suite asserts routes
      // are REACHABLE, not that they are gated, so its seeded caller needs the
      // admin-tier permissions those routes now declare.
      role: overrides.role ?? 'ADMIN',
      platformRole: overrides.platformRole ?? null,
      // OWNER is reserved for the platform owner identities — the users-table
      // trigger rejects the row otherwise, so an OWNER fixture must carry one.
      ...(overrides.role === 'OWNER' ? { email: 'james.mcdaniel@people.ai' } : {}),
    },
  })
  const permissions = resolvePermissions(
    { role: user.role, platformRole: user.platformRole },
    { kind: org.kind },
  )
  const auth: AuthContext = {
    organizationId: org.id,
    userId: user.id,
    dbUser: user,
    user: { id: user.supabaseId } as never,
    permissions,
    can: (permission) => permissions.has(permission),
    features: DEFAULT_FEATURES,
    hasFeature: (feature) => DEFAULT_FEATURES.has(feature),
  }
  const cleanup = async () => {
    setTestAuthContext(null)
    // Owner rows can never be deleted (trigger), and the org delete cascades to
    // its users — detach them first so teardown doesn't abort.
    await prisma.user.updateMany({ where: { organizationId: org.id, role: 'OWNER' }, data: { organizationId: null } }).catch(() => {})
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {})
  }
  return { organizationId: org.id, userId: user.id, auth, cleanup }
}

export function installTestAuth(auth: AuthContext): void {
  setTestAuthContext(auth)
}
export function clearTestAuth(): void {
  setTestAuthContext(null)
}

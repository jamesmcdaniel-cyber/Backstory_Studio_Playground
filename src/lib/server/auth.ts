import { getAuthWithUser } from '@/lib/supabase/auth-utils'
import { resolveEntitlement } from '@/lib/entitlement'
import { backstoryGateEnabled, backstoryMcpReady, ensureBackstoryConnection } from '@/lib/mcp/backstory-connection'
import { isPlatformPrivileged, resolvePermissions, type Permission } from '@/lib/authz/permissions'
import { emailDomain, isEnterpriseIdentity, satisfiesMfaPolicy } from '@/lib/auth/enterprise-policy'
import {
  evaluateSsoRequirement,
  markIdentityProviderUsed,
  resolveIdentityProviderForEmail,
} from '@/lib/auth/identity-providers'
import { isPlatformOwnerEmail } from '@/lib/authz/platform-owner'
import { DEFAULT_FEATURES, resolveFeatures, type Feature } from '@/lib/authz/features'
import { resolveDemoOrganization } from '@/lib/demo/session'
import { prisma } from '@/lib/prisma'

type AuthResult = NonNullable<Awaited<ReturnType<typeof getAuthWithUser>>>

export interface AuthContext {
  user: AuthResult['user']
  dbUser: NonNullable<AuthResult['dbUser']>
  userId: string
  organizationId: string
  /** Everything this caller may do, resolved once per request. */
  permissions: ReadonlySet<Permission>
  can(permission: Permission): boolean
  /**
   * Everything switched ON for this caller, resolved once per request from
   * workspace / team / user grants.
   *
   * Separate from `permissions` on purpose: authority and entitlement are
   * different questions, and merging them makes it easy to gate authority on a
   * billing flag — or a purchase on a role.
   */
  features: ReadonlySet<Feature>
  hasFeature(feature: Feature): boolean
}

// Production-inert test seam: mirrors src/lib/observability/sentry.ts's
// injectable reporter. A route smoke test injects a seeded auth context so it
// can drive real handlers without a Supabase session. NEVER active in
// production — double-gated on NODE_ENV and TEST_DATABASE_URL (production sets
// neither), and null by default so real auth runs unless a test injects.
//
// Stored on globalThis via Symbol.for (not module state) DELIBERATELY: under
// tsx, a test file and the route chain can load this module as two instances
// (CJS/ESM duality), and a module-local variable set by the test was invisible
// to the copy the routes call — the seam silently fell through to real auth.
// Symbol.for is process-global, so every instance reads the same slot.
const TEST_AUTH_SLOT = Symbol.for('backstory.testAuthContext')

export function setTestAuthContext(ctx: AuthContext | null): void {
  ;(globalThis as Record<symbol, unknown>)[TEST_AUTH_SLOT] = ctx
}

function getTestAuthContext(): AuthContext | null {
  return ((globalThis as Record<symbol, unknown>)[TEST_AUTH_SLOT] as AuthContext | null) ?? null
}

function testAuthActive(): boolean {
  return process.env.NODE_ENV !== 'production' && Boolean(process.env.TEST_DATABASE_URL)
}

export class AuthContextError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
    readonly code: string = 'AUTH_ERROR',
  ) {
    super(message)
    this.name = 'AuthContextError'
  }
}

/**
 * The entitlement gate is enforced in production (Backstory Studio is
 * exclusively for People.ai Sales AI customers). In development it defaults
 * off so a fresh clone works; force with ENTITLEMENT_GATE=on|off.
 */
export function entitlementGateEnabled(): boolean {
  const flag = process.env.ENTITLEMENT_GATE
  if (flag === 'on') return true
  if (flag === 'off') return false
  return process.env.NODE_ENV === 'production'
}

/** Throws 403 ENTITLEMENT_REQUIRED when the org has no active Sales AI entitlement. */
export async function assertEntitled(organizationId: string): Promise<void> {
  const entitlement = await resolveEntitlement(organizationId)
  if (!entitlement.entitled) {
    throw new AuthContextError(
      'An active Backstory Sales AI connection is required.',
      403,
      'ENTITLEMENT_REQUIRED',
    )
  }
}

/** Throws 403 PERMISSION_DENIED, naming the permission the caller lacked. */
export class PermissionDeniedError extends AuthContextError {
  constructor(readonly required: Permission) {
    super('You do not have permission to do that.', 403, 'PERMISSION_DENIED')
    this.name = 'PermissionDeniedError'
  }
}

export async function requireAuthContext(
  options?: { skipBackstoryGate?: boolean; skipEntitlementGate?: boolean; skipMfaGate?: boolean; skipSsoGate?: boolean },
): Promise<AuthContext> {
  const injected = getTestAuthContext()
  if (process.env.QA_SEAM_DEBUG) console.log('[seam-debug]', { injected: Boolean(injected), active: testAuthActive(), testDb: Boolean(process.env.TEST_DATABASE_URL), nodeEnv: process.env.NODE_ENV })
  if (injected && testAuthActive()) return injected

  const auth = await getAuthWithUser()

  if (!auth?.user || !auth.userId) {
    throw new AuthContextError('Authentication required', 401)
  }

  // Checked BEFORE the dbUser test, which a deactivated account also fails —
  // the generic message there reads as "you have no workspace" and sends the
  // person to support instead of telling them what happened. Deactivation takes
  // effect on the next request, not when the access token expires, because this
  // runs per request against the live row (see resolveAuthUser).
  if (auth.deactivated) {
    throw new AuthContextError(
      'This account has been deactivated. Contact your workspace administrator.',
      403,
      'ACCOUNT_DEACTIVATED',
    )
  }

  // Platform admission, re-asked per request by resolveAuthUser because the
  // password grant never passes through the OAuth callback that used to be the
  // only place it was checked. Distinct from ACCOUNT_DEACTIVATED: the account is
  // intact, its DOMAIN no longer has platform access (or never did).
  if (auth.accessRevoked) {
    throw new AuthContextError(
      'Your organization no longer has access to this platform. Contact your administrator.',
      403,
      'PLATFORM_ACCESS_REVOKED',
    )
  }

  if (!auth.dbUser || !auth.organizationId) {
    throw new AuthContextError('Organization access required', 403)
  }

  const organization = auth.dbUser.organization

  // Resolved BEFORE the MFA gate, which needs to know whether this caller holds
  // cross-workspace privilege. It is pure and costs no query (getAuthWithUser
  // already included the organization on dbUser), so hoisting it is free.
  const permissions = resolvePermissions(
    { role: auth.dbUser.role, platformRole: auth.dbUser.platformRole, email: auth.dbUser.email },
    { kind: organization?.kind ?? 'customer' },
  )

  // Privileged accounts are held to MFA whatever their workspace policy says.
  //
  // OWNER is the platform root tier — every permission in every workspace,
  // including customer workspaces — and platform.administer is the operator
  // console. Both were following the ordinary workspace policy, which DEFAULTS
  // to 'optional' and, for the owner's auto-provisioned workspace
  // (applyOwnerBootstrap), was never going to be anything else. So the single
  // most privileged credential on the platform could be a password with no
  // second factor.
  //
  // Recovery is the existing one and needs no exemption here: /auth/mfa is a
  // public page that enrolls through Supabase directly rather than through a
  // gated route, so an account that trips this can always reach enrollment.
  // Per-workspace SSO enforcement, checked per request for the same reason the
  // platform admission check is: the password grant never passes through the
  // OAuth callback, so a gate that lives only there governs one way in. That is
  // exactly the hole the 2026-08-13 admission fix closed, and re-creating it
  // here would be repeating a known mistake.
  //
  // Deliberately NOT applied to the platform owner: every other lockout in this
  // file exempts them, because a configuration mistake must never leave the
  // platform with nobody able to correct it.
  if (!isPlatformOwnerEmail(auth.dbUser.email)) {
    const identityProvider = await resolveIdentityProviderForEmail(auth.dbUser.email)
    const ssoDecision = evaluateSsoRequirement({ provider: identityProvider, methods: auth.authMethods })
    if (!ssoDecision.allowed) {
      throw new AuthContextError(ssoDecision.message, 403, 'SSO_REQUIRED')
    }
    if (identityProvider && isEnterpriseIdentity(auth.authMethods)) {
      // Fire and forget: an unused or dead IdP should be visible, but recording
      // that must never delay or fail a sign-in that already succeeded.
      void markIdentityProviderUsed(identityProvider.id)
    }
  }

  const features = await resolveUserFeatures(auth.organizationId, auth.dbUser.id)

  const privileged = isPlatformPrivileged(permissions)
  const mfaPolicy = privileged ? 'required' : (organization?.mfaPolicy ?? 'optional')
  if (!options?.skipMfaGate && !satisfiesMfaPolicy(mfaPolicy, auth.assuranceLevel, auth.authMethods, auth.dbUser.email)) {
    throw new AuthContextError(
      privileged
        ? 'Multi-factor authentication is required for platform administrator accounts.'
        : 'Multi-factor authentication is required by this workspace.',
      403,
      'MFA_REQUIRED',
    )
  }
  if (!options?.skipSsoGate && organization?.ssoEnforced) {
    const domain = emailDomain(auth.dbUser.email)
    const claimed = domain
      ? await prisma.organizationDomain.findFirst({
          where: { organizationId: auth.organizationId, domain, status: 'verified' },
          select: { id: true },
        })
      : null
    if (claimed && !isEnterpriseIdentity(auth.authMethods)) {
      throw new AuthContextError('Sign in through your workspace identity provider.', 403, 'SSO_REQUIRED')
    }
  }

  // Native Backstory MCP: seed the per-user connection row (idempotent, never
  // throws), then hard-gate the platform until the user has authorized it.
  await ensureBackstoryConnection(auth.organizationId, auth.dbUser.id)

  if (!options?.skipEntitlementGate && entitlementGateEnabled()) {
    await assertEntitled(auth.organizationId)
  }

  if (!options?.skipBackstoryGate && backstoryGateEnabled()) {
    const ready = await backstoryMcpReady(auth.organizationId, auth.dbUser.id)
    if (!ready) {
      throw new AuthContextError(
        'Connect your Backstory MCP account to continue.',
        403,
        'BACKSTORY_MCP_REQUIRED',
      )
    }
  }

  // Demo mode: every gate above has already judged the REAL workspace —
  // entitlement, MFA, SSO, Backstory MCP, platform admission. Only the tenant
  // the request operates on is redirected, so the tenant guard and RLS scope
  // the whole handler to the sandbox. Permissions and features stay the real
  // ones: the demo org's kind grants nothing (REVIEWING_ORG_KINDS and
  // OPERATING_ORG_KINDS exclude 'demo', pinned by test), and resolution ran
  // before this line from the real org.
  const demoOrganizationId = await resolveDemoOrganization(auth.dbUser.id)

  return {
    user: auth.user,
    dbUser: auth.dbUser,
    userId: auth.userId,
    organizationId: demoOrganizationId ?? auth.organizationId,
    permissions,
    can: (permission) => permissions.has(permission),
    features,
    // Deliberately a separate predicate from `can`. A permission asks whether
    // someone has the AUTHORITY to do something; a feature asks whether it is
    // switched on for them. Merging them into one call would make it easy to
    // gate authority on a billing flag, or a purchase on a role.
    hasFeature: (feature) => features.has(feature),
  }
}

/**
 * The features this person holds, resolved from workspace / team / user grants.
 *
 * One query, joined on membership, rather than three. Failures resolve to the
 * defaults rather than throwing: a feature-flag lookup must never be able to
 * take down a request that authentication already approved — the failure would
 * present as a total outage rather than a missing feature.
 */
async function resolveUserFeatures(
  organizationId: string,
  userId: string,
): Promise<Set<Feature>> {
  try {
    const [memberships, grants] = await Promise.all([
      prisma.teamMember.findMany({ where: { userId }, select: { teamId: true } }),
      prisma.featureGrant.findMany({
        where: { organizationId },
        select: { feature: true, enabled: true, teamId: true, userId: true },
      }),
    ])
    return resolveFeatures({
      grants,
      userId,
      teamIds: memberships.map((membership) => membership.teamId),
    })
  } catch {
    return new Set(DEFAULT_FEATURES)
  }
}

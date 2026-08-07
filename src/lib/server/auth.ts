import { getAuthWithUser } from '@/lib/supabase/auth-utils'
import { resolveEntitlement } from '@/lib/entitlement'
import { backstoryGateEnabled, backstoryMcpReady, ensureBackstoryConnection } from '@/lib/mcp/backstory-connection'
import { resolvePermissions, type Permission } from '@/lib/authz/permissions'
import { emailDomain, isEnterpriseIdentity, satisfiesMfaPolicy } from '@/lib/auth/enterprise-policy'
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

  if (!auth.dbUser || !auth.organizationId) {
    throw new AuthContextError('Organization access required', 403)
  }

  const organization = auth.dbUser.organization
  if (!options?.skipMfaGate && !satisfiesMfaPolicy(organization?.mfaPolicy ?? 'optional', auth.assuranceLevel)) {
    throw new AuthContextError('Multi-factor authentication is required by this workspace.', 403, 'MFA_REQUIRED')
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

  // `getAuthWithUser` already includes the organization on dbUser, so resolving
  // permissions costs no extra query.
  const permissions = resolvePermissions(
    { role: auth.dbUser.role, platformRole: auth.dbUser.platformRole, email: auth.dbUser.email },
    { kind: organization?.kind ?? 'customer' },
  )

  return {
    user: auth.user,
    dbUser: auth.dbUser,
    userId: auth.userId,
    organizationId: auth.organizationId,
    permissions,
    can: (permission) => permissions.has(permission),
  }
}

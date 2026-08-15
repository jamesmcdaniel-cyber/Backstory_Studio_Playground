/**
 * Which identity provider signs a person in, and whether they had to use it.
 *
 * The platform authenticates its own people through Okta. A customer reaching
 * this platform as an external delivery surface brings their own IdP — that is
 * what "external" means — so provider choice has to be per workspace, resolved
 * from the email domain, and enforceable.
 *
 * Supabase brokers the SAML/OIDC protocol itself. This module owns the parts
 * Supabase cannot: which provider serves which workspace, whether that
 * workspace REQUIRES it, and the decision a sign-in attempt gets.
 *
 * ── Why enforcement is a decision function, not a redirect ─────────────────
 *
 * Returning a verdict rather than performing a redirect keeps the rule testable
 * without a browser and usable from more than one caller — the sign-in page
 * routes on it, the auth callback rejects on it. The previous MFA work was
 * bitten by a policy that lived in exactly one route and therefore governed
 * exactly one way in.
 */

import { systemPrisma } from '@/lib/prisma'
import { emailDomain, isEnterpriseIdentity } from '@/lib/auth/enterprise-policy'

export type SsoEnforcement = 'optional' | 'required'

export interface ResolvedIdentityProvider {
  id: string
  organizationId: string
  name: string
  protocol: string
  /** Null until an operator finishes provisioning the connection in Supabase. */
  supabaseSsoId: string | null
  status: string
  enforcement: SsoEnforcement
}

/**
 * The IdP that serves an email address, resolved through its verified domain.
 *
 * Only VERIFIED domains resolve. An unverified domain is a claim, not a fact,
 * and honouring it would let anyone who can type a domain name into the
 * settings page route that domain's sign-ins at an IdP they control.
 */
export async function resolveIdentityProviderForEmail(
  email: string | null | undefined,
): Promise<ResolvedIdentityProvider | null> {
  const domain = emailDomain(email)
  if (!domain) return null

  // systemPrisma: tenant RESOLUTION — this runs before any tenant context
  // exists, which is precisely what the guarded client cannot express. The
  // lookup is keyed on a globally-unique VERIFIED domain and returns only
  // non-secret routing metadata (which IdP, is it live, is it required).
  const row = await systemPrisma.organizationDomain.findFirst({
    where: { domain, status: 'verified' },
    select: {
      organizationId: true,
      organization: { select: { ssoEnforcement: true } },
      identityProvider: {
        select: { id: true, name: true, protocol: true, supabaseSsoId: true, status: true },
      },
    },
  })

  if (!row?.identityProvider) return null

  return {
    id: row.identityProvider.id,
    organizationId: row.organizationId,
    name: row.identityProvider.name,
    protocol: row.identityProvider.protocol,
    supabaseSsoId: row.identityProvider.supabaseSsoId,
    status: row.identityProvider.status,
    enforcement: normalizeEnforcement(row.organization?.ssoEnforcement),
  }
}

export function normalizeEnforcement(value: string | null | undefined): SsoEnforcement {
  // Fail OPEN on an unrecognised value, uniquely in this codebase, and
  // deliberately: failing closed here means an unexpected string locks a
  // workspace out of its own account with no way back in through the product.
  // The blast radius of the safe-looking choice is worse than the risk.
  return value === 'required' ? 'required' : 'optional'
}

export type SsoDecision =
  | { allowed: true }
  | { allowed: false; reason: 'sso_required'; providerName: string | null; message: string }

/**
 * Whether a sign-in that used `methods` may proceed for this email.
 *
 * `methods` is the JWT `amr` claim — see enterprise-policy.ts, which already
 * owns the question of what counts as an enterprise-brokered identity. Reusing
 * it means "what is SSO" is answered in exactly one place; a second definition
 * would drift, and the two would disagree about Google-federated domains.
 */
export function evaluateSsoRequirement(params: {
  provider: ResolvedIdentityProvider | null
  methods: readonly string[]
}): SsoDecision {
  const { provider, methods } = params

  // No federated provider configured, or the workspace does not require one.
  if (!provider || provider.enforcement !== 'required') return { allowed: true }

  // A provider that is not live yet cannot be required — enforcing against a
  // pending connection would lock the workspace out during its own setup, which
  // is the moment they can least afford it.
  if (provider.status !== 'active' || !provider.supabaseSsoId) return { allowed: true }

  if (isEnterpriseIdentity(methods)) return { allowed: true }

  return {
    allowed: false,
    reason: 'sso_required',
    providerName: provider.name,
    message: `Your workspace requires signing in through ${provider.name}. Use the single sign-on option.`,
  }
}

/**
 * Record that a provider was used, so an unused or dead IdP is visible.
 *
 * Best-effort: a failure here must never fail a sign-in that has otherwise
 * succeeded.
 */
export async function markIdentityProviderUsed(id: string): Promise<void> {
  try {
    // systemPrisma: id-keyed observability write on the sign-in path, before
    // the request has established tenant context.
    await systemPrisma.identityProvider.updateMany({ where: { id }, data: { lastUsedAt: new Date() } })
  } catch {
    /* observability only */
  }
}

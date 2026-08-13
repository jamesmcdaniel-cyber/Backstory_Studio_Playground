/**
 * Platform access gate. A sign-in is admitted when the verified email's domain
 * is a hardcoded company domain, is named by ALLOWED_EMAIL_DOMAINS, or has an
 * ACTIVE PlatformAllowedDomain row — or when a live invitation names that
 * exact address, which is how one external person joins without opening their
 * whole company's domain.
 *
 * Called once per sign-in (not per request), so a direct query is cheaper than
 * a cache plus the invalidation bug a cache would invite.
 *
 * systemPrisma: this runs BEFORE the caller has a workspace, so there is no
 * org context for RLS to scope to — and platform_allowed_domains deliberately
 * denies the tenant role entirely (see its RLS migration).
 */
import { systemPrisma } from '@/lib/prisma'
import { emailDomain } from '@/lib/auth/enterprise-policy'
import { isCompanyEmail, isPublicEmailProvider, normalizeDomain } from '@/lib/auth/company-domain'
import { isPlatformOwnerEmail } from '@/lib/authz/platform-owner'

/**
 * Deploy-level allowlist, read from `ALLOWED_EMAIL_DOMAINS` (comma-separated).
 *
 * This exists because the PlatformAllowedDomain table is administered ONLY from
 * Settings → Platform, which the customer edition gates off — leaving a customer
 * deployment with no way to admit anyone but hardcoded staff, and no in-product
 * way to fix it. The env var is owned by whoever deploys, so it grants no power
 * to a customer org admin and inverts no boundary.
 *
 * Same two safety rules as the admin screen: entries must be well-formed bare
 * domains, and public email providers are refused outright — allowing one would
 * grant platform access to anyone with an email address.
 */
export function envAllowedDomains(): string[] {
  return (process.env.ALLOWED_EMAIL_DOMAINS ?? '')
    .split(',')
    .map((entry) => normalizeDomain(entry))
    .filter((domain): domain is string => domain !== null && !isPublicEmailProvider(domain))
}

/** True when `ALLOWED_EMAIL_DOMAINS` names this email's domain exactly. */
export function envAllowsEmail(email: string | null | undefined): boolean {
  const domain = emailDomain(email)
  if (!domain) return false
  return envAllowedDomains().includes(domain)
}

/** The active row for an email's domain, or null. Exact match only. */
async function activeRow(email: string | null | undefined) {
  const domain = emailDomain(email)
  if (!domain) return null
  return systemPrisma.platformAllowedDomain.findFirst({
    where: { domain, disabledAt: null },
    select: { organizationId: true },
  })
}

/**
 * True when a live invitation names this exact address.
 *
 * Person-scoped, not domain-scoped: it admits the one human a workspace admin
 * deliberately invited, and nobody else at their company. Admission ends when
 * the invitation does — expiry, revocation (status leaves PENDING), or
 * acceptance, after which the user row itself carries their access.
 *
 * This is why the public-email-provider rule does not apply here: allowing
 * gmail.com as a DOMAIN would admit anyone with an email address, while an
 * invitation to one gmail address admits exactly that person.
 */
async function hasLiveInvitation(email: string | null | undefined): Promise<boolean> {
  const normalized = email?.trim().toLowerCase()
  if (!normalized) return false
  // systemPrisma: pre-tenant by nature — the invitee has no workspace yet, so
  // there is no org context for RLS to scope the lookup to.
  const invitation = await systemPrisma.invitation.findFirst({
    where: { email: normalized, status: 'PENDING', expiresAt: { gt: new Date() } },
    select: { id: true },
  })
  return invitation !== null
}

/** True when this verified email may hold a session on the platform. */
export async function isAllowedEmail(email: string | null | undefined): Promise<boolean> {
  if (isCompanyEmail(email)) return true
  if (envAllowsEmail(email)) return true
  if ((await activeRow(email)) !== null) return true
  return hasLiveInvitation(email)
}

/**
 * True when this email's domain was explicitly BLOCKED on the domain-access
 * screen and nothing else admits it.
 *
 * This is the narrow, per-request half of admission, and it exists because
 * `isAllowedEmail` cannot be re-run per request: an externally invited person's
 * admission comes from an invitation that is CONSUMED at provisioning, after
 * which "the user row itself carries their access". Re-asking the full question
 * every request would lock those accounts out the moment they were provisioned.
 *
 * So the two halves are asked at the two moments each is correct for:
 *   - provisioning (no user row yet) → the full `isAllowedEmail` gate
 *   - every request thereafter      → this, the revocation dimension only
 *
 * What it closes: disabling a domain row is advertised as blocking new sign-ins
 * at once, and it did — but only on the OAuth callback, the one path that calls
 * `isAllowedEmail`. The password grant mints its session against Supabase
 * directly and never reaches that callback, so a revoked domain's members kept
 * getting brand-new sessions indefinitely. Deactivating their accounts is the
 * companion action on that screen, but it is explicitly OPTIONAL, so it cannot
 * be what holds this line.
 *
 * A row that is present and ACTIVE, or absent entirely, both return false: the
 * former is a live grant, the latter is an account whose access came from
 * somewhere other than a domain rule (an invitation, a company domain).
 *
 * Cost: one indexed point-read on a unique column, and only for addresses that
 * are neither company nor env-allowed — platform staff short-circuit before it.
 * Same tradeoff `resolveAuthUser` already accepts for the user row: cheaper than
 * the class of bug it removes, and never cached, because a cached revocation is
 * indistinguishable from no revocation at all.
 */
export async function isDomainAccessRevoked(email: string | null | undefined): Promise<boolean> {
  // The owner can never be locked out by configuration — the same invariant the
  // users-table trigger enforces against deactivation and deletion.
  if (isPlatformOwnerEmail(email)) return false
  if (isCompanyEmail(email)) return false
  if (envAllowsEmail(email)) return false
  const domain = emailDomain(email)
  if (!domain) return false
  // systemPrisma: platform config, read before any tenant context exists — and
  // platform_allowed_domains denies the tenant role outright.
  const row = await systemPrisma.platformAllowedDomain.findUnique({
    where: { domain },
    select: { disabledAt: true },
  })
  return row?.disabledAt != null
}

/**
 * The shared workspace a newly provisioned user from this domain should join,
 * or null when the domain has no ACTIVE allowlist row — in which case they take
 * the invite/solo-workspace provisioning path.
 *
 * Admission and routing are separate questions, and a company domain answers
 * them differently: `isAllowedEmail` admits it from the hardcoded list with no
 * row at all, while THIS function still needs a row to know which workspace its
 * people belong in. Without one, every employee is provisioned into a solo
 * workspace of their own and cannot see a colleague's org-scoped flows or
 * agents — so the domain-access screen accepts a company domain as a
 * routing-only entry.
 */
export async function allowedDomainOrg(email: string | null | undefined): Promise<string | null> {
  return (await activeRow(email))?.organizationId ?? null
}

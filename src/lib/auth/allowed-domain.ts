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

/**
 * Deploy-level allowlist, read from `ALLOWED_EMAIL_DOMAINS` (comma-separated).
 *
 * This exists because the PlatformAllowedDomain table is administered ONLY from
 * `/admin/domains`, which the customer edition gates off — leaving a customer
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
 * The shared workspace a newly provisioned user from this domain should join,
 * or null when the domain has no ACTIVE allowlist row — in which case they take
 * the invite/solo-workspace provisioning path.
 *
 * Admission and routing are separate questions, and a company domain answers
 * them differently: `isAllowedEmail` admits it from the hardcoded list with no
 * row at all, while THIS function still needs a row to know which workspace its
 * people belong in. Without one, every employee is provisioned into a solo
 * workspace of their own and cannot see a colleague's org-scoped flows or
 * agents — so /admin/domains accepts a company domain as a routing-only entry.
 */
export async function allowedDomainOrg(email: string | null | undefined): Promise<string | null> {
  return (await activeRow(email))?.organizationId ?? null
}

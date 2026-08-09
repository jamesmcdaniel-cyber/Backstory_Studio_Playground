/**
 * Platform access gate. A sign-in is admitted when the verified email's domain
 * is either a hardcoded company domain or an ACTIVE PlatformAllowedDomain row.
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

/** True when this verified email may hold a session on the platform. */
export async function isAllowedEmail(email: string | null | undefined): Promise<boolean> {
  if (isCompanyEmail(email)) return true
  if (envAllowsEmail(email)) return true
  return (await activeRow(email)) !== null
}

/**
 * The shared workspace a newly provisioned user from this domain should join,
 * or null when the domain has no allowlist row (company staff included — they
 * keep the existing invite/solo-workspace provisioning path).
 */
export async function allowedDomainOrg(email: string | null | undefined): Promise<string | null> {
  return (await activeRow(email))?.organizationId ?? null
}

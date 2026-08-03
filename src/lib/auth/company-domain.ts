export const COMPANY_EMAIL_DOMAINS = ['people.ai', 'backstory.ai'] as const

/** Exact domain comparison prevents lookalikes such as people.ai.attacker.tld. */
export function isCompanyEmail(email: string | null | undefined): boolean {
  if (!email) return false
  const normalized = email.trim().toLowerCase()
  const separator = normalized.lastIndexOf('@')
  if (separator <= 0) return false
  return COMPANY_EMAIL_DOMAINS.includes(normalized.slice(separator + 1) as (typeof COMPANY_EMAIL_DOMAINS)[number])
}

/**
 * Free/consumer email providers. Allowing one of these would grant platform
 * access to anyone with an email address, so they are refused outright — this
 * is the highest-consequence mistake an operator can make on that screen.
 */
export const PUBLIC_EMAIL_PROVIDERS = [
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'gmx.net',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'tutanota.com',
  'fastmail.com',
] as const

export function isPublicEmailProvider(domain: string): boolean {
  return (PUBLIC_EMAIL_PROVIDERS as readonly string[]).includes(domain.trim().toLowerCase())
}

// A bare hostname: dot-separated labels, no wildcard, no path, no whitespace,
// at least one dot. Deliberately strict — this string becomes an authorization
// boundary, and the exact-match comparison downstream only holds if the stored
// value is a plain hostname.
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

/**
 * Normalize operator input to a storable domain, or null when it is not a
 * plain hostname. Accepts a leading '@' so pasting "@customer.com" works;
 * rejects a full email address, since storing one would silently allow only
 * that address while reading as a domain rule.
 */
export function normalizeDomain(input: string | null | undefined): string | null {
  const trimmed = input?.trim().toLowerCase()
  if (!trimmed) return null
  const withoutAt = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed
  if (withoutAt.includes('@')) return null
  return DOMAIN_PATTERN.test(withoutAt) ? withoutAt : null
}

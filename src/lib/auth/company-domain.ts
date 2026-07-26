export const COMPANY_EMAIL_DOMAINS = ['people.ai', 'backstory.ai'] as const

/** Exact domain comparison prevents lookalikes such as people.ai.attacker.tld. */
export function isCompanyEmail(email: string | null | undefined): boolean {
  if (!email) return false
  const normalized = email.trim().toLowerCase()
  const separator = normalized.lastIndexOf('@')
  if (separator <= 0) return false
  return COMPANY_EMAIL_DOMAINS.includes(normalized.slice(separator + 1) as (typeof COMPANY_EMAIL_DOMAINS)[number])
}

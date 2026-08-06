/**
 * Who may hold platform review ("super admin") rights, addressed by email.
 *
 * Three layers, all normalized to lowercase exact-match:
 *  - DEFAULT_PLATFORM_STAFF_EMAILS: hardcoded so no env or table edit can lock
 *    the platform admin out (same posture as usage/budget.ts exemptions).
 *  - PLATFORM_STAFF_EMAILS: env recovery path for the bootstrap problem.
 *  - platform_staff_emails table: grants added from the Reviews console for
 *    people who have not signed in yet, claimed at provisioning.
 */

export const DEFAULT_PLATFORM_STAFF_EMAILS = ['james.mcdaniel@people.ai']

export function normalizeStaffEmail(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase()
  return normalized || null
}

/** Emails promoted to reviewer on sign-in (defaults ∪ env). Read at call time. */
export function staffBootstrapAllowlist(): Set<string> {
  const extra = (process.env.PLATFORM_STAFF_EMAILS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
  return new Set([...DEFAULT_PLATFORM_STAFF_EMAILS, ...extra])
}

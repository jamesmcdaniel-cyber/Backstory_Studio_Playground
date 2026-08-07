/**
 * The platform owner identity: the two addresses that may hold the OWNER role.
 *
 * OWNER is the platform's root tier — every permission in every workspace,
 * including external customer workspaces. That only stays safe if the role is
 * bound to identity rather than to mutable database state, so this list is a
 * hardcoded closed set: no env union, no table, no admin surface can extend it
 * (the same posture as DEFAULT_PLATFORM_STAFF_EMAILS, but stricter — that list
 * accepts env additions, this one deliberately does not).
 *
 * The invariants enforced on these accounts, at every layer that can write a
 * user row (API routes, SCIM, People.ai team join, privacy deletion, and a
 * BEFORE INSERT/UPDATE/DELETE trigger on users as the final backstop —
 * prisma/migrations/20260806090000_platform_owner_protection):
 *   - their role is always OWNER and cannot be changed by anyone
 *   - they cannot be deactivated, removed from a workspace, or deleted
 *   - no other account can ever be granted OWNER
 *
 * Changing this list is a deliberate code change + the companion migration,
 * never runtime configuration.
 */

export const PLATFORM_OWNER_EMAILS = [
  'james.mcdaniel@people.ai',
  'james.mcdaniel@backstory.ai',
] as const

const OWNER_EMAIL_SET: ReadonlySet<string> = new Set<string>(PLATFORM_OWNER_EMAILS)

/** Whether `email` is a platform owner address. Lowercase exact-match. */
export function isPlatformOwnerEmail(email: string | null | undefined): boolean {
  const normalized = email?.trim().toLowerCase()
  return Boolean(normalized && OWNER_EMAIL_SET.has(normalized))
}

/** Message + code shared by every surface that refuses to touch an owner row. */
export const OWNER_PROTECTED_MESSAGE = 'This account is the platform owner and cannot be modified, demoted, or removed.'
export const OWNER_PROTECTED_CODE = 'OWNER_PROTECTED'
export const OWNER_RESERVED_MESSAGE = 'The Owner role is reserved for the platform owner.'
export const OWNER_RESERVED_CODE = 'OWNER_RESERVED'

/**
 * "Super admin" as the product names it, and `platformRole = 'reviewer'` as the
 * database stores it.
 *
 * Super admin is a PLATFORM tier layered on top of a workspace role, not a
 * fourth workspace role — resolvePermissions unions the two axes, and the tier
 * only resolves inside an internal or partner workspace. The member RBAC
 * surface still presents it as one choice above Admin, because "super admin"
 * reads as a rank to the person assigning it; this module is where that
 * presentation maps back onto the two stored columns.
 *
 * The other stored value, 'staff', marks an employee without granting review.
 * It has no place in the member dropdown, which is why every mapping here is
 * explicit about reviewer rather than about "any platform role".
 */

/** The stored platformRole that grants catalogue review — i.e. super admin. */
export const SUPER_ADMIN_PLATFORM_ROLE = 'reviewer'

/** Org kinds in which a super-admin grant actually resolves to permissions. */
const REVIEWING_ORG_KINDS = new Set(['internal', 'partner'])

export function isSuperAdminPlatformRole(platformRole: string | null | undefined): boolean {
  return platformRole === SUPER_ADMIN_PLATFORM_ROLE
}

/**
 * Why a super-admin grant is dormant, or null when it takes effect.
 *
 * A grant inside a customer workspace is stored but inert (the org-kind gate in
 * resolvePermissions). Saying so beats a silent no-op.
 */
export function dormantSuperAdminReason(orgKind: string | null | undefined): string | null {
  if (REVIEWING_ORG_KINDS.has(orgKind ?? '')) return null
  return 'Granted, but dormant: review rights activate once this workspace is marked internal or partner under Settings → Platform.'
}

/** The single select the Members tab shows. SUPER_ADMIN is presentation only. */
export type AssignableMemberRole = 'SUPER_ADMIN' | 'ADMIN' | 'USER' | 'VIEWER'

/** What the member row's select should read, given both stored columns. */
export function memberRoleOption(
  role: string,
  platformRole: string | null | undefined,
): AssignableMemberRole | 'OWNER' {
  if (isSuperAdminPlatformRole(platformRole) && role !== 'OWNER') return 'SUPER_ADMIN'
  if (role === 'OWNER' || role === 'ADMIN' || role === 'USER' || role === 'VIEWER') return role
  return 'USER'
}

/** The workspace role a chosen option stores. Super admins administer their workspace. */
export function workspaceRoleFor(option: AssignableMemberRole): 'ADMIN' | 'USER' | 'VIEWER' {
  return option === 'SUPER_ADMIN' ? 'ADMIN' : option
}

/**
 * The PATCH body for moving an existing member to `option`.
 *
 * platformRole is sent ONLY when the super-admin-ness flips. An ordinary role
 * change that also cleared the column would strip the separate 'staff'
 * employee marker off anyone who carries it, silently and invisibly.
 */
export function memberRolePatch(
  option: AssignableMemberRole,
  currentPlatformRole: string | null | undefined,
): { role: 'ADMIN' | 'USER' | 'VIEWER'; platformRole?: string | null } {
  const role = workspaceRoleFor(option)
  const willBeSuperAdmin = option === 'SUPER_ADMIN'
  if (isSuperAdminPlatformRole(currentPlatformRole) === willBeSuperAdmin) return { role }
  return { role, platformRole: willBeSuperAdmin ? SUPER_ADMIN_PLATFORM_ROLE : null }
}

/** The POST body for inviting someone at `option`. Super admin travels as a grant. */
export function invitePayload(
  email: string,
  option: AssignableMemberRole,
): { email: string; role: 'ADMIN' | 'USER' | 'VIEWER'; platformRole?: string } {
  const role = workspaceRoleFor(option)
  if (option !== 'SUPER_ADMIN') return { email, role }
  return { email, role, platformRole: SUPER_ADMIN_PLATFORM_ROLE }
}

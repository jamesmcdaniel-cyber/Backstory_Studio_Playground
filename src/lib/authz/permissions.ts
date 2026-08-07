/**
 * The permission registry: the single source of truth for what a caller may do.
 *
 * Before this, authorization was ~9 inline `role === 'ADMIN'` comparisons
 * scattered across routes and components, with no way to express a
 * platform-level tier at all. Now every route declares the permission it needs
 * (`withAuthenticatedApi(handler, { permission })`) and this module decides who
 * holds it.
 *
 * Two INDEPENDENT axes union together:
 *   - the org role     — what you may do inside your own workspace
 *   - the platform tier — whether you are Backstory, People.ai, or a customer
 *
 * Roles are fixed bundles. Orgs cannot define their own, and permissions are
 * not grantable on individual resources; both were considered and deliberately
 * left out (see the spec's non-goals).
 */
import type { UserRole } from '@prisma/client'
import { isPlatformOwnerEmail } from '@/lib/authz/platform-owner'

export const PERMISSIONS = [
  'flow.read', 'flow.write', 'flow.run',
  'agent.read', 'agent.write', 'agent.run',
  'integration.manage', 'members.manage', 'org.manage', 'audit.read',
  'security.manage', 'data.export', 'api.manage', 'workspace.delete',
  'template.author', 'template.submit',
  'catalogue.review', 'catalogue.publish', 'catalogue.takedown',
] as const

export type Permission = (typeof PERMISSIONS)[number]

export type PermissionUser = { role: UserRole; platformRole: string | null; email?: string | null }
export type PermissionOrg = { kind: string }

/** Org kinds whose members may propose entries to the shared catalogue. */
const SUBMITTING_ORG_KINDS = new Set(['internal', 'partner'])

// Cumulative bundles: each role adds to the one above it.
const VIEWER_PERMISSIONS: Permission[] = ['flow.read', 'agent.read']
const MEMBER_PERMISSIONS: Permission[] = [
  ...VIEWER_PERMISSIONS,
  'flow.write', 'flow.run', 'agent.write', 'agent.run', 'template.author',
]
const ADMIN_PERMISSIONS: Permission[] = [
  ...MEMBER_PERMISSIONS,
  'integration.manage', 'members.manage', 'org.manage', 'audit.read',
  'security.manage', 'data.export', 'api.manage',
]

const BY_ROLE: Record<UserRole, Permission[]> = {
  VIEWER: VIEWER_PERMISSIONS,
  USER: MEMBER_PERMISSIONS,
  ADMIN: ADMIN_PERMISSIONS,
  // OWNER is the platform root tier: every permission, everywhere. The role is
  // only assignable to the platform owner identities (src/lib/authz/
  // platform-owner.ts), enforced at every write path and by a users-table
  // trigger, so the full grant cannot leak to anyone else.
  OWNER: [...PERMISSIONS],
}

/**
 * The permissions held by `user` acting inside `org`.
 *
 * Pure: no DB access, no env reads, no clock. The whole role × org-kind matrix
 * is therefore unit-testable without a database.
 */
export function resolvePermissions(user: PermissionUser, org: PermissionOrg): ReadonlySet<Permission> {
  // The platform owner holds everything by IDENTITY, not by stored role: even
  // if the role column were tampered with out-of-band, the grant stands (and
  // the sign-in bootstrap restores the column). Still pure — the allowlist is
  // a hardcoded constant, not env or DB state.
  if (isPlatformOwnerEmail(user.email)) return new Set<Permission>(PERMISSIONS)

  const granted = new Set<Permission>(BY_ROLE[user.role] ?? VIEWER_PERMISSIONS)

  // Platform overlay. Both checks are gated on the ORG kind as well as the
  // user's flag: a reviewer who moves to a customer workspace loses review
  // rights immediately, without anyone having to remember to clear the flag.
  const submittingOrg = SUBMITTING_ORG_KINDS.has(org.kind)
  if (submittingOrg) granted.add('template.submit')
  if (submittingOrg && user.platformRole === 'reviewer') {
    granted.add('catalogue.review')
    granted.add('catalogue.publish')
    granted.add('catalogue.takedown')
  }

  return granted
}

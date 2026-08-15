import type { Prisma, UserRole } from '@prisma/client'
import { revokeUserAccess } from '@/lib/revoke-user-access'

/**
 * Move a user into another workspace.
 *
 * Membership is a single-org FK on User, so a transfer is one column write —
 * which is exactly the bug this module exists to fix. Several models carry
 * BOTH a `userId` and an `organizationId`: they are the user's own rows, but
 * they are stamped with the workspace they were created in. Rewriting only
 * `User.organizationId` strands every one of them in the old org, where they
 * keep surfacing in that workspace's `[organizationId, ...]` queries while
 * being invisible (and un-recreatable) to the person who owns them.
 *
 * The concrete symptoms this closes:
 *   - Integration was uniquely keyed on [userId, provider], so after a move the
 *     user could not reconnect the same provider at all — the stale row from
 *     their previous workspace occupied the key. (Now keyed per-org; see the
 *     20260731 migration.)
 *   - Their Backstory MCP row lived in the old org, so `backstoryMcpReady`
 *     failed in the new one and the platform gate re-triggered.
 *   - Their People.ai tokens, MCP servers, and push subscriptions stayed
 *     readable by a workspace they had left.
 *
 * REVOKE, don't re-home. Every row handled here carries a credential or a
 * delivery target. Re-homing an OAuth connection into a new workspace would
 * silently expose the user's connected account to a different set of people,
 * so the user reconnects instead. That is the isolation-preserving default and
 * the only one that is safe without asking.
 *
 * What deliberately STAYS with the old workspace: agents and flows they
 * authored, execution history, chat sessions, and audit events. Those describe
 * work done inside that org and belong to it, not to the person.
 */

/** Models revoked on transfer, in the order they are deleted. */
export const REVOKED_ON_TRANSFER = [
  'integration',
  'peopleAiConnection',
  'mcpConnection',
  // Was missing: a transferred user's Nango connection stayed behind in the
  // workspace they left, readable by people they no longer worked with.
  'nangoConnection',
  // Personal HTTP credentials, once http_credentials gained an owner. Org-shared
  // rows (userId: null) are deliberately untouched — they belong to the
  // workspace, not to the person leaving it.
  'httpCredential',
  'pushSubscription',
] as const

export interface TransferResult {
  moved: boolean
  revoked: Record<(typeof REVOKED_ON_TRANSFER)[number], number>
}

/**
 * Reassign `userId` to `toOrganizationId` and revoke the per-user rows stamped
 * with the workspace they are leaving. Must run inside a transaction so a user
 * is never left moved-but-not-revoked (their old credentials readable from a
 * workspace they no longer belong to).
 *
 * Idempotent: transferring a user into the org they are already in revokes
 * nothing and reports `moved: false`, so a double-accepted invite is harmless.
 */
export async function transferUserToOrganization(
  tx: Prisma.TransactionClient,
  params: {
    userId: string
    fromOrganizationId: string | null
    toOrganizationId: string
    role: UserRole
  },
): Promise<TransferResult> {
  const { userId, fromOrganizationId, toOrganizationId, role } = params
  // Derived from the manifest rather than written out, so adding a credential
  // class to REVOKED_ON_TRANSFER cannot leave a stale zero-map behind.
  const empty = Object.fromEntries(REVOKED_ON_TRANSFER.map((name) => [name, 0])) as TransferResult['revoked']

  if (fromOrganizationId === toOrganizationId) {
    return { moved: false, revoked: empty }
  }

  await tx.user.update({
    where: { id: userId },
    data: { organizationId: toOrganizationId, role },
  })

  // Nothing to revoke for a user who had no workspace yet (fresh provision).
  if (!fromOrganizationId) return { moved: true, revoked: empty }

  // One revocation implementation, shared with deprovisioning, rather than two
  // that drift. This module's copy was the one that already worked — and the
  // fact that deactivation never called it is the entire reason the revocation
  // spine exists.
  const revocation = await revokeUserAccess(tx, {
    userId,
    organizationId: fromOrganizationId,
    reason: 'org_transfer',
  })

  // A transfer is NOT a deprovisioning: the person is still employed and still
  // owns their work. revokeUserAccess quarantines because its usual caller is a
  // suspension; here that would stop flows nobody asked to stop.
  await Promise.all([
    tx.flow.updateMany({ where: { organizationId: fromOrganizationId, userId }, data: { quarantinedAt: null } }),
    tx.agentTask.updateMany({ where: { organizationId: fromOrganizationId, userId }, data: { quarantinedAt: null } }),
  ])

  return { moved: true, revoked: revocation.credentials }
}

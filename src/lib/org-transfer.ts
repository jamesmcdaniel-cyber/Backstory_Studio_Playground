import type { Prisma, UserRole } from '@prisma/client'

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
  const empty = { integration: 0, peopleAiConnection: 0, mcpConnection: 0, pushSubscription: 0 }

  if (fromOrganizationId === toOrganizationId) {
    return { moved: false, revoked: empty }
  }

  await tx.user.update({
    where: { id: userId },
    data: { organizationId: toOrganizationId, role },
  })

  // Nothing to revoke for a user who had no workspace yet (fresh provision).
  if (!fromOrganizationId) return { moved: true, revoked: empty }

  const scope = { organizationId: fromOrganizationId, userId }

  // Each delete is org-scoped, so the tenant guard is satisfied and a bug in
  // this function can only ever touch the workspace being left.
  const [integration, peopleAiConnection, mcpConnection, pushSubscription] = await Promise.all([
    tx.integration.deleteMany({ where: scope }),
    tx.peopleAiConnection.deleteMany({ where: scope }),
    // Personal MCP rows only. `userId: null` marks an org-shared server added
    // via the connections page — that belongs to the workspace, not the leaver.
    tx.mcpConnection.deleteMany({ where: scope }),
    tx.pushSubscription.deleteMany({ where: scope }),
  ])

  return {
    moved: true,
    revoked: {
      integration: integration.count,
      peopleAiConnection: peopleAiConnection.count,
      mcpConnection: mcpConnection.count,
      pushSubscription: pushSubscription.count,
    },
  }
}

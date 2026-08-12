import type { Prisma } from '@prisma/client'
import { systemPrisma } from '@/lib/prisma'
import { recordAudit } from '@/lib/audit'
import { credentialRevokeOutboxEvent } from '@/lib/outbox'

/**
 * Revoke everything one person holds in one workspace.
 *
 * Deprovisioning used to be identity-only — `isActive: false` plus a banned
 * session — while every credential stayed live. The OAuth grants outlived the
 * account at the provider, and scheduled work kept running under whichever
 * colleague the scheduler picked next.
 *
 * REVOKE, don't re-home, and QUARANTINE, don't delete. Credentials are removed
 * because the person is gone; the work they built is kept because other teams
 * depend on it, and an admin claims it (see src/lib/quarantine.ts). Destroying
 * it would turn a security fix into an outage.
 *
 * Runs inside the caller's transaction so a user is never left deactivated but
 * still holding credentials. The upstream Nango deletion is deliberately NOT
 * done here: it is a network call, and an admin suspending a hostile account
 * must never be blocked by a vendor outage. The returned
 * `pendingUpstreamRevokes` is what the caller enqueues.
 *
 * MUST be given an UNGUARDED transaction (`systemPrisma.$transaction`). The
 * owner-liveness guard hides exactly these rows once `isActive` is false, so
 * revoking through the guarded client would silently revoke NOTHING for anyone
 * already deactivated — returning success with zero counts while the
 * credentials stay live. That is the worst possible failure for this function,
 * so the type below is the un-extended client on purpose.
 */

export type RevocationReason = 'member_removed' | 'deactivated' | 'scim_deprovisioned' | 'org_transfer'

export interface RevocationResult {
  credentials: {
    integration: number
    peopleAiConnection: number
    mcpConnection: number
    nangoConnection: number
    pushSubscription: number
  }
  apiKeysRevoked: number
  quarantined: { flows: number; agentTasks: number }
  /** Grants still live at the provider. The caller enqueues one job per entry. */
  pendingUpstreamRevokes: Array<{ connectionId: string; providerConfigKey: string }>
}

export async function revokeUserAccess(
  tx: Prisma.TransactionClient,
  params: { userId: string; organizationId: string; reason: RevocationReason },
): Promise<RevocationResult> {
  const { userId, organizationId } = params
  const scope = { organizationId, userId }
  const now = new Date()

  // Read the Nango rows BEFORE deleting them — once gone, there is no record of
  // which upstream grants still need deleting.
  const nangoRows = await tx.nangoConnection.findMany({
    where: scope,
    select: { connectionId: true, providerConfigKey: true },
  })

  // Every delete is org-scoped AND user-scoped, so a bug here can only touch this
  // one person in this one workspace. `userId` in the scope is also what keeps
  // org-owned rows (userId: null) — shared MCP servers, workspace Nango
  // connections — out of the blast radius.
  const [integration, peopleAiConnection, mcpConnection, nangoConnection, pushSubscription] = await Promise.all([
    tx.integration.deleteMany({ where: scope }),
    tx.peopleAiConnection.deleteMany({ where: scope }),
    tx.mcpConnection.deleteMany({ where: scope }),
    tx.nangoConnection.deleteMany({ where: scope }),
    tx.pushSubscription.deleteMany({ where: scope }),
  ])

  // These already fail closed at authentication (public-api/auth.ts re-checks
  // isActive). Marking them revoked is what makes a credential inventory honest.
  const apiKeys = await tx.apiKey.updateMany({
    where: { ...scope, revokedAt: null },
    data: { revokedAt: now },
  })

  const [flows, agentTasks] = await Promise.all([
    tx.flow.updateMany({ where: { ...scope, quarantinedAt: null }, data: { quarantinedAt: now } }),
    tx.agentTask.updateMany({ where: { ...scope, quarantinedAt: null }, data: { quarantinedAt: now } }),
  ])

  return {
    credentials: {
      integration: integration.count,
      peopleAiConnection: peopleAiConnection.count,
      mcpConnection: mcpConnection.count,
      nangoConnection: nangoConnection.count,
      pushSubscription: pushSubscription.count,
    },
    apiKeysRevoked: apiKeys.count,
    quarantined: { flows: flows.count, agentTasks: agentTasks.count },
    pendingUpstreamRevokes: nangoRows,
  }
}

/**
 * Deactivate + revoke + enqueue the upstream deletions, atomically.
 *
 * Every deprovision path calls THIS, not revokeUserAccess directly, so no path
 * can deactivate without revoking. That is the failure this whole sub-project
 * exists to close: the revocation logic already existed in org-transfer.ts, and
 * deactivation simply never called it.
 *
 * systemPrisma: revocation must not be subject to the owner-liveness filter it
 * exists to make true — see the note on revokeUserAccess. It is also a
 * cross-workspace operator path (the admin console deprovisions users in other
 * orgs), which the guarded client would reject outright.
 *
 * Does NOT touch Supabase — session banning differs per caller (the operator
 * console bans before flipping the column; SCIM bans as part of its own update)
 * and belongs to them.
 */
export async function deprovisionUser(params: {
  userId: string
  organizationId: string
  reason: RevocationReason
  actorUserId?: string | null
}): Promise<RevocationResult> {
  const { userId, organizationId, reason, actorUserId } = params

  const result = await systemPrisma.$transaction(async (tx) => {
    const revocation = await revokeUserAccess(tx, { userId, organizationId, reason })

    await tx.user.update({ where: { id: userId }, data: { isActive: false } })

    // Enqueued in the SAME transaction as the local revocation, so there is no
    // window where the row is gone but nothing remembers to delete the grant.
    for (const grant of revocation.pendingUpstreamRevokes) {
      await tx.outboxEvent.create({
        data: credentialRevokeOutboxEvent({ organizationId, userId, ...grant }),
      })
    }

    return revocation
  })

  await recordAudit({
    organizationId,
    action: 'member.deprovisioned',
    actorUserId: actorUserId ?? null,
    resourceType: 'user',
    resourceId: userId,
    detail: {
      reason,
      credentials: result.credentials,
      apiKeysRevoked: result.apiKeysRevoked,
      quarantined: result.quarantined,
      upstreamRevokesQueued: result.pendingUpstreamRevokes.length,
    },
  })

  // A separate row, not just a field on the one above: the claim queue is an
  // operational surface, and "what got quarantined and when" is the question an
  // admin asks weeks later without wanting to reconstruct a deprovisioning.
  if (result.quarantined.flows > 0 || result.quarantined.agentTasks > 0) {
    await recordAudit({
      organizationId,
      action: 'work.quarantined',
      actorUserId: actorUserId ?? null,
      resourceType: 'user',
      resourceId: userId,
      detail: { reason, ...result.quarantined },
    })
  }

  return result
}

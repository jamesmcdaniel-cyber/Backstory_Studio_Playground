import { prisma } from '@/lib/prisma'
import { recordAudit } from '@/lib/audit'

/**
 * Work whose owner was deprovisioned.
 *
 * Quarantine is what keeps a security fix from becoming an outage: the flows a
 * suspended person built often matter to other teams, so they are stopped and
 * made VISIBLE rather than deleted or silently re-owned. An admin claims one
 * and it resumes under their identity and their credentials.
 *
 * The queue is DERIVED from `quarantinedAt` — no separate model to drift.
 */

export type QuarantinedKind = 'flow' | 'agent'

export interface QuarantinedItem {
  kind: QuarantinedKind
  id: string
  name: string
  quarantinedAt: Date
  formerOwnerEmail: string | null
}

export async function listQuarantinedWork(organizationId: string): Promise<QuarantinedItem[]> {
  const [flows, agents] = await Promise.all([
    prisma.flow.findMany({
      where: { organizationId, quarantinedAt: { not: null } },
      select: { id: true, name: true, quarantinedAt: true, userId: true },
      orderBy: { quarantinedAt: 'desc' },
    }),
    prisma.agentTask.findMany({
      where: { organizationId, quarantinedAt: { not: null } },
      select: { id: true, description: true, quarantinedAt: true, userId: true },
      orderBy: { quarantinedAt: 'desc' },
    }),
  ])

  // Resolved separately rather than through a relation include: Flow.userId has
  // no `user` relation on the model (AgentTask's is named `owner`), so there is
  // no single join to write. One extra query on a list that is empty in the
  // normal case is the cheaper trade against a schema migration for a model the
  // owner-liveness registry does not cover.
  const ownerIds = [
    ...new Set([...flows, ...agents].map((row) => row.userId).filter((id): id is string => Boolean(id))),
  ]
  const owners = ownerIds.length
    ? await prisma.user.findMany({
        where: { id: { in: ownerIds }, organizationId },
        select: { id: true, email: true },
      })
    : []
  const emailById = new Map(owners.map((owner) => [owner.id, owner.email]))

  return [
    ...flows.map((row) => ({
      kind: 'flow' as const,
      id: row.id,
      name: row.name,
      quarantinedAt: row.quarantinedAt!,
      formerOwnerEmail: (row.userId && emailById.get(row.userId)) || null,
    })),
    ...agents.map((row) => ({
      kind: 'agent' as const,
      id: row.id,
      name: row.description,
      quarantinedAt: row.quarantinedAt!,
      formerOwnerEmail: (row.userId && emailById.get(row.userId)) || null,
    })),
  ].sort((a, b) => b.quarantinedAt.getTime() - a.quarantinedAt.getTime())
}

/**
 * Take ownership.
 *
 * Rebinds `userId` and clears the stamp — `status` is deliberately untouched,
 * because quarantine never wrote it. Had quarantine set status to DISABLED, the
 * prior value would be gone and every claimed draft would come back ACTIVE.
 */
export async function claimQuarantinedWork(params: {
  organizationId: string
  kind: QuarantinedKind
  id: string
  claimantUserId: string
}): Promise<boolean> {
  const { organizationId, kind, id, claimantUserId } = params
  const where = { id, organizationId, quarantinedAt: { not: null } }
  const data = { userId: claimantUserId, quarantinedAt: null }

  const updated =
    kind === 'flow'
      ? await prisma.flow.updateMany({ where, data })
      : await prisma.agentTask.updateMany({ where, data })

  // Zero means it was already claimed (or never quarantined). Not an error —
  // two admins racing on the same row is ordinary — but it must not write an
  // audit row claiming a transfer of ownership that did not happen.
  if (updated.count === 0) return false

  await recordAudit({
    organizationId,
    action: 'work.claimed',
    actorUserId: claimantUserId,
    resourceType: kind,
    resourceId: id,
  })
  return true
}

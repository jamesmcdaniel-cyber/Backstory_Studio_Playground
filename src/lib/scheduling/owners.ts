import { systemPrisma } from '@/lib/prisma'

/**
 * Resolve, in two queries, which user each scheduled run is attributed to.
 *
 * The scheduler did this per candidate — up to two `user.findFirst` calls inside
 * the dispatch loop, so a full tick was ~150 extra round-trips against the same
 * handful of rows. Since dispatch is capped, the candidate set is small and
 * bounded by the time this runs, so both lookups collapse into one query each.
 *
 * Attribution rule, unchanged: the row's own `userId` when it is set and that
 * user is still an active member of the row's org; otherwise the org's oldest
 * active member, because a shared agent or flow has no single owner.
 */

export interface OwnedCandidate {
  id: string
  organizationId: string
  userId: string | null
}

/**
 * A user row, as both lookups below select it.
 *
 * `isActive` is carried explicitly rather than filtered in SQL because the two
 * lookups need it for opposite reasons: the fallback list wants only active
 * members, while the explicit-owner list MUST include inactive ones so
 * attributeOwners can tell a deprovisioned owner (stop the work) from an absent
 * one (fall back). Filtering both in SQL is what made those indistinguishable.
 */
export interface ActiveMember {
  id: string
  organizationId: string | null
  isActive: boolean
}

/**
 * The attribution rule itself, with no database in it.
 *
 * `members` must be ordered oldest-first — the fallback is "the org's oldest
 * active member", and this function preserves that by taking the first it sees
 * per org rather than re-sorting.
 *
 * Returns candidate id → user id. A candidate whose org has no active member at
 * all is ABSENT from the map, and callers must skip it: dispatching with no user
 * would create an unattributable run.
 */
export function attributeOwners(
  candidates: OwnedCandidate[],
  explicitOwners: ActiveMember[],
  members: ActiveMember[],
): Map<string, string> {
  const owners = new Map<string, string>()
  const explicitById = new Map(explicitOwners.map((user) => [user.id, user]))

  const fallbackByOrg = new Map<string, string>()
  for (const member of members) {
    if (member.isActive && member.organizationId && !fallbackByOrg.has(member.organizationId)) {
      fallbackByOrg.set(member.organizationId, member.id)
    }
  }

  for (const candidate of candidates) {
    const explicit = candidate.userId ? explicitById.get(candidate.userId) : undefined

    // A named owner who was DEPROVISIONED stops the work entirely. Falling back
    // here would hand a suspended person's automation to an unrelated colleague
    // and keep running it under THEIR identity — the exact failure the
    // revocation spine exists to close. Absent from the map = callers skip it.
    //
    // Note this is deliberately narrower than "no active explicit owner": a
    // dangling userId with no row, or an owner who moved workspaces, still falls
    // back, because neither means someone was suspended.
    if (explicit && !explicit.isActive) continue

    // The named owner counts only if they are still in THIS org. Without that
    // check, someone who moved workspaces would keep being credited with — and
    // have their identity used for — runs in the org they left.
    const owner =
      explicit?.organizationId === candidate.organizationId
        ? candidate.userId!
        : fallbackByOrg.get(candidate.organizationId)
    if (owner) owners.set(candidate.id, owner)
  }

  return owners
}

/** `attributeOwners`, fed by two batched queries. */
export async function resolveRunOwners(candidates: OwnedCandidate[]): Promise<Map<string, string>> {
  if (candidates.length === 0) return new Map()

  const explicitIds = [...new Set(candidates.map((c) => c.userId).filter((id): id is string => Boolean(id)))]
  const orgIds = [...new Set(candidates.map((c) => c.organizationId))]

  // systemPrisma: scheduler attribution across orgs (CRON_SECRET-gated). `User`
  // is not an org-guarded model; the org match is asserted in attributeOwners.
  const [explicitOwners, members] = await Promise.all([
    explicitIds.length
      ? systemPrisma.user.findMany({
          // NOT filtered on isActive: attributeOwners must be able to tell a
          // DEACTIVATED owner (stop the work) from an ABSENT one (fall back).
          // Filtering here collapsed both into "missing", which is how a
          // suspended person's scheduled work kept running under a colleague.
          where: { id: { in: explicitIds } },
          select: { id: true, organizationId: true, isActive: true },
        })
      : Promise.resolve([] as ActiveMember[]),
    systemPrisma.user.findMany({
      where: { organizationId: { in: orgIds }, isActive: true },
      select: { id: true, organizationId: true, isActive: true },
      orderBy: { createdAt: 'asc' },
    }),
  ])

  return attributeOwners(candidates, explicitOwners, members)
}

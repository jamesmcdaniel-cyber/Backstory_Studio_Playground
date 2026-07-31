import { systemPrisma } from '@/lib/prisma'

/**
 * Per-organization run concurrency.
 *
 * Agents and flows share ONE worker pool, and nothing bounded how much of it a
 * single workspace could hold. An org firing fifty scheduled flows filled every
 * slot; every other org's runs sat in `pending` until the reaper failed them at
 * the run timeout. The only existing ceiling was the monthly token budget, which
 * is a spend limit — it does not stop one tenant starving the others inside a
 * single tick.
 *
 * The budget is deliberately shared across agents AND flows, because the thing
 * being rationed is worker slots, not rows in a particular table. Runs paused on
 * a human (`waiting`) do not count: they hold no slot, and counting them would
 * let one unanswered approval permanently shrink a workspace's capacity.
 *
 * This governs SCHEDULED dispatch — the burst path. Interactive runs stay
 * governed by their per-org rate limit, so a person clicking Run is never told
 * their workspace is full by a cron sweep.
 */

/** Runs occupying a worker slot right now. `waiting` is excluded by design. */
const OCCUPYING_STATUSES = ['pending', 'running'] as const

export function orgMaxInFlightRuns(): number {
  const raw = Number(process.env.ORG_MAX_INFLIGHT_RUNS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10
}

/**
 * In-flight run count per org, across agent executions and flow runs, for the
 * given orgs only. Orgs with nothing in flight are absent from the map.
 */
export async function inFlightRunsByOrg(organizationIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (organizationIds.length === 0) return counts

  const where = {
    organizationId: { in: organizationIds },
    status: { in: [...OCCUPYING_STATUSES] },
  }

  // systemPrisma: cross-org capacity read for the scheduler (CRON_SECRET-gated);
  // the org set is supplied by the caller and every row is counted under its own org.
  const [agentRuns, flowRuns] = await Promise.all([
    systemPrisma.agentExecution.groupBy({ by: ['organizationId'], where, _count: { _all: true } }),
    systemPrisma.flowRun.groupBy({ by: ['organizationId'], where, _count: { _all: true } }),
  ])

  for (const row of [...agentRuns, ...flowRuns]) {
    counts.set(row.organizationId, (counts.get(row.organizationId) ?? 0) + row._count._all)
  }
  return counts
}

/**
 * A mutable per-tick view of each org's remaining capacity.
 *
 * `tryClaim` is what the dispatch loop calls: it reserves a slot when one is
 * free and reports false when the workspace is saturated, so the caller defers
 * that candidate to the next tick instead of queueing behind a full pool.
 */
export class OrgCapacity {
  private readonly limit = orgMaxInFlightRuns()
  private readonly saturated = new Set<string>()

  constructor(private readonly inFlight: Map<string, number>) {}

  static async forOrgs(organizationIds: string[]): Promise<OrgCapacity> {
    return new OrgCapacity(await inFlightRunsByOrg(organizationIds))
  }

  /** Reserve a slot for `organizationId`, or return false when it is full. */
  tryClaim(organizationId: string): boolean {
    const used = this.inFlight.get(organizationId) ?? 0
    if (used >= this.limit) {
      this.saturated.add(organizationId)
      return false
    }
    this.inFlight.set(organizationId, used + 1)
    return true
  }

  /** Orgs that hit their ceiling this tick — for a single summary log line. */
  saturatedOrgs(): string[] {
    return [...this.saturated]
  }
}

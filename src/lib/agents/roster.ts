import { deriveGroupRoleLabel, deriveRoleLabel } from '@/lib/agents/derive-role'

import type { Agent, Teammate } from '@/lib/types'

/**
 * Lifetime run stats for one card, aggregated across whatever it fronts.
 *
 * `runs`/`completed`/`failed`/`blocked` are QUERY-DERIVED (from the KPI
 * groupBy) — exact, and the only source `successRate` reads. `approximateRuns`
 * is a SEPARATE bucket: additional runs known only via an agent's own
 * optimistic counter (see `statsFor`), with no outcome breakdown available.
 * Keeping the two apart means a mixed-provenance group never inflates its
 * measured total with a number that carries no success/failure signal, and
 * never divides a success rate across runs whose outcome is unknown.
 *
 * `blocked` counts runs that produced their work but could not deliver it
 * through a write integration that never resolved. It is tracked apart from
 * both `completed` and `failed` — nothing errored, but nothing shipped either.
 */
export type CardStats = { runs: number; completed: number; failed: number; blocked: number; approximateRuns: number }

/** How busy a card looks at a glance. */
export type Presence = 'working' | 'ready' | 'idle'

export type TeammateCard = {
  kind: 'teammate'
  teammate: Teammate
  /** The jobs on this avatar's roster, in display order. */
  agents: Agent[]
  /** Set when the avatar fronts exactly one job — the card then behaves as a solo one. */
  soleAgent: Agent | null
  stats: CardStats
  presence: Presence
  /** Instant, network-free role, shown until (or unless) an AI label arrives. */
  derivedRole: string | null
}

export type AgentCard = {
  kind: 'agent'
  agent: Agent
  stats: CardStats
  presence: Presence
  /** Instant, network-free role, shown until (or unless) an AI label arrives. */
  derivedRole: string | null
}

export type RosterCardModel = TeammateCard | AgentCard

/**
 * Turn the raw agent list, the avatar list, and per-agent run counts into the
 * cards the gallery draws.
 *
 * Kept out of the component because the interesting behavior is all here: which
 * avatars are shown at all, how a group's stats add up, and when a teammate is
 * really just one agent wearing a name.
 */

function statsFor(agent: Agent, kpis: Record<string, CardStats>): CardStats {
  const kpi = kpis[agent.id]
  // A KPI hit is exact (from the groupBy query) -- normalize away any missing
  // `approximateRuns` on the wire shape (the /api/agents/kpis payload only
  // ever sends runs/completed/failed/blocked) rather than trust the caller's object.
  if (kpi) return { runs: kpi.runs, completed: kpi.completed, failed: kpi.failed, blocked: kpi.blocked ?? 0, approximateRuns: 0 }
  // executionCount is the agent's own counter and survives run pruning, so it
  // is the better "runs" figure when no execution rows are left to count --
  // but it carries no completed/failed split, so it lands in approximateRuns,
  // never in the measured `runs` bucket successRate reads.
  return { runs: 0, completed: 0, failed: 0, blocked: 0, approximateRuns: agent.executionCount ?? 0 }
}

export function presenceFor(agent: Agent): Presence {
  const configured = agent.status === 'active' && Boolean(agent.instructions?.trim())
  if (!configured) return 'idle'
  return agent.schedule?.isActive ? 'working' : 'ready'
}

/** The busiest state on a roster — one agent on the clock makes the avatar working. */
function groupPresence(agents: Agent[]): Presence {
  if (agents.some((agent) => presenceFor(agent) === 'working')) return 'working'
  if (agents.some((agent) => presenceFor(agent) === 'ready')) return 'ready'
  return 'idle'
}

/**
 * Add up a roster's stats, keeping query-derived and counter-approximate
 * numbers in their own buckets throughout -- never combined into one total
 * that would look measured but isn't.
 */
function sumStats(agents: Agent[], kpis: Record<string, CardStats>): CardStats {
  return agents.reduce<CardStats>((total, agent) => {
    const stats = statsFor(agent, kpis)
    return {
      runs: total.runs + stats.runs,
      completed: total.completed + stats.completed,
      failed: total.failed + stats.failed,
      blocked: total.blocked + stats.blocked,
      approximateRuns: total.approximateRuns + stats.approximateRuns,
    }
  }, { runs: 0, completed: 0, failed: 0, blocked: 0, approximateRuns: 0 })
}

/**
 * Percentage of FINISHED runs that succeeded, or null while nothing has
 * finished. Reads only the query-derived outcome split -- an agent counted in
 * `approximateRuns` (no known outcome) never enters this denominator, so a
 * group of purely counter-fallback agents correctly reports "no rate" rather
 * than a rate over runs whose result is unknown.
 *
 * Blocked runs count as finished-but-not-successful. They belong in the
 * denominator and out of the numerator: an agent that ran every day and
 * delivered nothing, because its Gmail integration never resolved, must not
 * read as 100%.
 */
export function successRate(stats: Pick<CardStats, 'completed' | 'failed'> & { blocked?: number }): number | null {
  const finished = stats.completed + stats.failed + (stats.blocked ?? 0)
  if (finished <= 0) return null
  return Math.round((stats.completed / finished) * 100)
}

/**
 * Does this card answer the search box?
 *
 * A teammate matches on the JOBS it runs as well as its own name, because
 * people look for the work ("renewals") at least as often as the worker.
 */
function matchesQuery(haystack: Array<string | null | undefined>, needle: string): boolean {
  return haystack.some((value) => value?.toLocaleLowerCase().includes(needle))
}

export function buildRoster(
  agents: Agent[],
  teammates: Teammate[],
  kpis: Record<string, CardStats>,
  query = '',
): { teammateCards: TeammateCard[]; agentCards: AgentCard[] } {
  const grouped = new Map<string, Agent[]>()
  const solo: Agent[] = []
  for (const agent of agents) {
    if (!agent.teammateId) {
      solo.push(agent)
      continue
    }
    const bucket = grouped.get(agent.teammateId)
    if (bucket) bucket.push(agent)
    else grouped.set(agent.teammateId, [agent])
  }

  const teammateCards = teammates
    .map((teammate) => {
      const roster = (grouped.get(teammate.id) ?? []).slice().sort((a, b) => a.title.localeCompare(b.title))
      return {
        kind: 'teammate' as const,
        teammate,
        agents: roster,
        soleAgent: roster.length === 1 ? roster[0] : null,
        stats: sumStats(roster, kpis),
        presence: groupPresence(roster),
        derivedRole: deriveGroupRoleLabel(roster.map((agent) => deriveRoleLabel(agent.title, agent.instructions))),
      }
    })
    // An avatar whose agents are all invisible to this user (private to someone
    // else, or deleted) would render as an empty stranger. Drop it rather than
    // advertise that it exists.
    .filter((card) => card.agents.length > 0)
    .sort((a, b) => a.teammate.name.localeCompare(b.teammate.name))

  const agentCards = solo
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((agent) => ({
      kind: 'agent' as const,
      agent,
      stats: statsFor(agent, kpis),
      presence: presenceFor(agent),
      derivedRole: deriveRoleLabel(agent.title, agent.instructions),
    }))

  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return { teammateCards, agentCards }
  return {
    teammateCards: teammateCards.filter((card) =>
      matchesQuery(
        [card.teammate.name, card.teammate.roleLabel, card.derivedRole, ...card.agents.map((agent) => agent.title)],
        needle,
      )),
    agentCards: agentCards.filter((card) =>
      matchesQuery([card.agent.title, card.agent.roleLabel, card.derivedRole, card.agent.description], needle)),
  }
}

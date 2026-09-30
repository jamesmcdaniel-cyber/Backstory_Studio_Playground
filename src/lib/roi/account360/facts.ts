import type { Account360Facts } from './prep'

/**
 * What the ROI Analyst sees of an Account 360 run: every number its headline
 * may cite, over the full window, already computed. The dashboard itself
 * reads the full bundle; the model never needs the per-month arrays.
 */

export type Account360Summary = {
  window: { clickStream: string; pipelineMonths: string; lastMonthPartial: boolean }
  accounts: { total: number; engaged: number; noEngagement: number }
  cutoffs: { sessions: number; deepActionShare: number }
  cohorts: Array<{ cohort: string; accounts: number; avgCreated: number; avgClosedWon: number; totalCreated: number; totalClosedWon: number }>
  ratios: {
    powerVsNoEngagementCreated: number | null
    powerVsNoEngagementClosedWon: number | null
    depthLiftFrequentPct: number | null
    depthLiftInfrequentPct: number | null
  }
  lowVolumeWithPipeline: string[]
  zeroEngagementWithPipeline: string[]
  topUsers: Array<{ user: string; accounts: number; events: number; sessions: number }>
  excludedUsers: string[]
  events: { total: number; counted: number; users: number }
  wonAfterWindow: number
  notes: string[]
}

function round(value: number, places = 1): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

export function summarizeAccount360(facts: Account360Facts): Account360Summary {
  const b = facts.BUNDLE
  const m = facts.META
  const cohort = (name: string) => b.cohorts_static.find((c) => c.cohort === name)
  const power = cohort('Power Users')
  const browser = cohort('Frequent Browsers')
  const digger = cohort('Focused Diggers')
  const light = cohort('Light Touch')
  const none = cohort('No Engagement')
  const ratio = (a?: number, c?: number) => (a !== undefined && c ? round(a / c) : null)
  const lift = (a?: number, c?: number) => (a !== undefined && c ? round((a / c - 1) * 100, 0) : null)
  return {
    window: {
      clickStream: `${m.clickStart} to ${m.clickEnd}`,
      pipelineMonths: b.months.length ? `${b.months[0]} to ${b.months[b.months.length - 1]}` : '',
      lastMonthPartial: m.lastMonthPartial,
    },
    accounts: { total: m.accounts, engaged: m.engaged, noEngagement: m.noEngagement },
    cutoffs: { sessions: b.session_median, deepActionShare: b.depth_ratio_median },
    cohorts: b.cohorts_static.map((c) => ({
      cohort: c.cohort,
      accounts: c.n,
      avgCreated: Math.round(c.avg_created),
      avgClosedWon: Math.round(c.avg_closed_won),
      totalCreated: Math.round(c.total_created),
      totalClosedWon: Math.round(c.total_closed_won),
    })),
    ratios: {
      powerVsNoEngagementCreated: ratio(power?.avg_created, none?.avg_created),
      powerVsNoEngagementClosedWon: ratio(power?.avg_closed_won, none?.avg_closed_won),
      depthLiftFrequentPct: lift(power?.avg_created, browser?.avg_created),
      depthLiftInfrequentPct: lift(digger?.avg_created, light?.avg_created),
    },
    lowVolumeWithPipeline: b.whale_names,
    zeroEngagementWithPipeline: b.dark_names,
    topUsers: b.top_users.slice(0, 5).map((u) => ({ user: u.user, accounts: u.unique_accounts, events: u.total_events, sessions: u.unique_sessions })),
    excludedUsers: m.excludedUsers,
    events: { total: m.eventsTotal, counted: m.eventsUsed, users: m.usersActive },
    wonAfterWindow: Math.round(m.wonBeyondWindow),
    notes: facts.notes,
  }
}

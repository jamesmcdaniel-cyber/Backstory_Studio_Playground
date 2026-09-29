import type { RoiFacts } from './prep'

/**
 * The compact view of the facts the model writes from. The full facts hold
 * per-rep matrices (megabytes); the model needs the window averages, the
 * deal tables and the stage/persona results — a few kilobytes, all exact.
 * The math here mirrors the dashboard's own JS (winAvg / monthly) so what
 * the narrative says and what the charts show never disagree.
 */

export type WindowAverages = Record<string, number | null> & { n: number }

function range(a: number, b: number): number[] {
  const out: number[] = []
  for (let i = a; i <= b; i += 1) out.push(i)
  return out
}

export function windows(monthCount: number): Record<string, number[]> {
  const NM = monthCount
  return {
    L3: range(Math.max(0, NM - 3), NM - 1),
    P3: range(Math.max(0, NM - 6), Math.max(0, NM - 4)),
    L6: range(Math.max(0, NM - 6), NM - 1),
    P6: range(Math.max(0, NM - 12), Math.max(0, NM - 7)),
    PY: range(Math.max(0, NM - 18), Math.max(0, NM - 13)),
    L12: range(Math.max(0, NM - 12), NM - 1),
    P12: range(0, Math.max(0, NM - 13)),
  }
}

export function popMask(U: NonNullable<RoiFacts['U']>, pop: string): boolean[] {
  return U.users.map((u) => (pop === 'all' ? true : pop === 'User' || pop === 'Non-user' ? u.f === pop : u.t === pop))
}

/** Per-rep mean across the window's months, then mean across reps. */
export function winAvg(U: NonNullable<RoiFacts['U']>, mask: boolean[], monthIdx: number[]): WindowAverages {
  const out: Record<string, number | null> = {}
  let n = 0
  for (const key of Object.keys(U.labels)) {
    const M = U.m[key]
    let sum = 0
    let count = 0
    for (let i = 0; i < M.length; i += 1) {
      if (!mask[i]) continue
      let rs = 0
      let rc = 0
      for (const j of monthIdx) {
        const v = M[i][j]
        if (v !== null && v !== undefined) { rs += v; rc += 1 }
      }
      if (rc) { sum += rs / rc; count += 1 }
    }
    out[key] = count ? sum / count : null
    if (key === 'meeting_count') n = count
  }
  return { ...out, n } as WindowAverages
}

function round(value: number | null | undefined, digits = 2): number | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function roundAverages(avg: WindowAverages): Record<string, number | null> {
  return Object.fromEntries(Object.entries(avg).map(([key, value]) => [key, key === 'n' ? value : round(value as number | null)]))
}

function monthLabel(month: string): string {
  const [year, mm] = month.split('-')
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(mm) - 1]} ${year}`
}

export type RoiFactsSummary = ReturnType<typeof summarizeFacts>

export function summarizeFacts(facts: RoiFacts) {
  const U = facts.U
  let activity: Record<string, unknown> | null = null
  if (U) {
    const W = windows(U.months.length)
    const pops = ['all', ...(U.hasUsage ? ['User', 'Non-user', 'High', 'Medium', 'Low'] : [])]
    const byPopulation: Record<string, Record<string, Record<string, number | null>>> = {}
    for (const pop of pops) {
      const mask = popMask(U, pop)
      byPopulation[pop] = {}
      for (const [name, idx] of Object.entries(W)) {
        if (!idx.length) continue
        byPopulation[pop][name] = roundAverages(winAvg(U, mask, idx))
      }
    }
    const tierCounts = { High: 0, Medium: 0, Low: 0 }
    for (const user of U.users) if (user.t && user.t in tierCounts) tierCounts[user.t as keyof typeof tierCounts] += 1
    activity = {
      months: { first: monthLabel(U.months[0]), last: monthLabel(U.months[U.months.length - 1]), count: U.months.length },
      windows: Object.fromEntries(Object.entries(W).filter(([, idx]) => idx.length).map(([name, idx]) => [name, `${monthLabel(U.months[idx[0]])} – ${monthLabel(U.months[idx[idx.length - 1]])}`])),
      metrics: U.labels,
      reps: U.users.length,
      usage: U.hasUsage
        ? { matchedReps: U.nUsage, usageRecords: U.usageRecords, bottomFivePercent: U.nBottom, users: U.users.filter((u) => u.f === 'User').length, tierCuts: U.tierCuts, tierCounts }
        : null,
      /** averages per rep per month; keys are metric ids, values by population then window */
      averagesPerRepPerMonth: byPopulation,
    }
  }
  const OPP = facts.OPP
  const deals = OPP
    ? Object.fromEntries(Object.entries(OPP).map(([type, tables]) => [type, {
        excludingTransactional: { n: tables.excl.n, winRate: tables.excl.win_rate, decileCorrelation: tables.excl.r_win, deciles: tables.excl.deciles, levels: tables.excl.levels },
        includingTransactional: tables.incl === tables.excl ? 'same as excluding (no cycle times)' : { n: tables.incl.n, winRate: tables.incl.win_rate, levels: tables.incl.levels },
      }]))
    : null
  const ST = facts.ST
  const stages = ST
    ? {
        base: ST.base,
        lateStageDeals: ST.n_late,
        earlyStages: ST.earlyStages,
        lateStages: ST.lateStages,
        postDecisionStages: ST.postStages,
        cycleTimeMatchPct: ST.cycleMatch,
        byStage: ST.stages.map((row) => ({ stage: row.stage, shareOfActivityPct: row.share, dirAbovePct: row.dir_above_pct, wonActsPerDeal: row.won_acts, lostActsPerDeal: row.lost_acts, wonDeals: row.won_n, lostDeals: row.lost_n, personaPct: row.persona_pct, channelPct: row.type_pct })),
        personas: ST.personas,
        earlyVsLate: ST.surv,
        breadth: ST.breadth,
        earlyActivityQuintiles: ST.early_q,
      }
    : null
  return {
    activity,
    deals,
    stages,
    meta: facts.META,
    notes: facts.notes,
  }
}

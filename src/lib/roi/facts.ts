import type { RoiDeals, RoiFacts, RoiMatrix } from './prep'
import { fiscalPeriodOf, resolveWindows, type RoiRunConfig } from './config'

/**
 * The compact view of the facts the model writes from. The full facts hold
 * per-rep matrices and every closed deal (megabytes); the model needs the
 * window averages, the deal tables and the stage/persona results — a few
 * kilobytes, all exact. The math here mirrors the report's own script
 * (winAvg / monthly / the deal buckets) so what the narrative says and what
 * the charts show never disagree.
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

// ---------------------------------------------------------------- decoding

/** A matrix as rows of months, whichever form the facts carry it in. */
export function decodeMatrix(matrix: RoiMatrix | undefined): Array<Array<number | null>> {
  if (!matrix) return []
  if (typeof matrix !== 'string') return matrix
  if (!matrix) return []
  return matrix.split(';').map((row) => row.split(',').map((cell) => (cell === '' ? null : Number(cell))))
}

/** The compact form the report embeds. */
export function encodeMatrix(matrix: RoiMatrix | undefined): string {
  if (typeof matrix === 'string') return matrix
  return (matrix ?? []).map((row) => row.map((cell) => (cell === null || cell === undefined ? '' : String(cell))).join(',')).join(';')
}

const decoded = new WeakMap<object, Map<string, Array<Array<number | null>>>>()

/** One metric's matrix, decoded once per facts object. */
export function matrixOf(U: NonNullable<RoiFacts['U']>, key: string): Array<Array<number | null>> {
  let cache = decoded.get(U)
  if (!cache) {
    cache = new Map()
    decoded.set(U, cache)
  }
  const hit = cache.get(key)
  if (hit) return hit
  const value = decodeMatrix(U.m[key] ?? U.mx?.[key])
  cache.set(key, value)
  return value
}

export type DecodedDeals = { types: string[]; months: string[]; s: number[]; w: number[]; d: number[]; t: number[]; m: number[]; x: number[] }

/** Every closed deal as plain columns (see RoiDeals for the encoding). */
export function decodeDeals(deals: RoiDeals): DecodedDeals {
  const n = deals.w.length
  const s: number[] = new Array(n)
  const w: number[] = new Array(n)
  const t: number[] = new Array(n)
  const m: number[] = new Array(n)
  const x: number[] = new Array(n)
  for (let i = 0; i < n; i += 1) {
    s[i] = parseInt(deals.s.slice(i * 2, i * 2 + 2), 36) / 10
    w[i] = deals.w.charCodeAt(i) === 49 ? 1 : 0
    t[i] = parseInt(deals.t[i], 36)
    const month = deals.m.slice(i * 2, i * 2 + 2)
    m[i] = month === 'zz' ? -1 : parseInt(month, 36)
    x[i] = deals.x.charCodeAt(i) === 49 ? 1 : 0
  }
  return { types: deals.types, months: deals.months, s, w, d: deals.d, t, m, x }
}

// ---------------------------------------------------------------- rep math

/**
 * Which rows a population takes. Readout facts hold group rows (see
 * readout-import.ts): the team row is "all", cohort rows the cohorts, and role
 * rows (the browser's role filter) none of these.
 */
export function popMask(U: NonNullable<RoiFacts['U']>, pop: string): boolean[] {
  return U.users.map((u) => {
    if (u.k === 'role') return false
    if (u.k === 'org') return pop === 'all'
    if (u.k === 'cohort' && pop === 'all') return false
    return pop === 'all' ? true : pop === 'User' || pop === 'Non-user' ? u.f === pop : u.t === pop
  })
}

/** Per-rep mean across the window's months, then mean across reps. */
export function winAvg(U: NonNullable<RoiFacts['U']>, mask: boolean[], monthIdx: number[], keys: string[] = Object.keys(U.labels)): WindowAverages {
  const out: Record<string, number | null> = {}
  let n = 0
  for (const key of keys) {
    const M = matrixOf(U, key)
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
      // A group row stands for `w` reps (readouts); a rep row for one.
      const weight = U.users[i]?.w ?? 1
      if (rc && weight) { sum += (rs / rc) * weight; count += weight }
    }
    out[key] = count ? sum / count : null
    if (key === 'meeting_count' || (n === 0 && key === keys[0])) n = count
  }
  return { ...out, n } as WindowAverages
}

// ---------------------------------------------------------------- deal math

export type DealBucket = { n: number; won: number; win_rate: number | null; med_days_won: number | null; med_days_lost: number | null; lo: number; hi: number }
export type DealGroup = { deciles: Array<DealBucket & { dec: number }>; levels: Array<DealBucket & { level: string }>; n: number; win_rate: number | null; r_win: number | null }

export const DEAL_LEVELS = ['Low (0–30)', 'Medium (31–70)', 'High (71+)'] as const

export function levelOf(score: number): 0 | 1 | 2 {
  return score <= 30 ? 0 : score <= 70 ? 1 : 2
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const r1 = (value: number | null): number | null => (value === null || Number.isNaN(value) ? null : Math.round(value * 10) / 10)

function bucket(deals: DecodedDeals, idx: number[]): DealBucket {
  let won = 0
  let lo = Infinity
  let hi = -Infinity
  const daysWon: number[] = []
  const daysLost: number[] = []
  for (const i of idx) {
    won += deals.w[i]
    lo = Math.min(lo, deals.s[i])
    hi = Math.max(hi, deals.s[i])
    if (deals.d[i] >= 0) (deals.w[i] ? daysWon : daysLost).push(deals.d[i])
  }
  return { n: idx.length, won, win_rate: idx.length ? r1((won / idx.length) * 100) : null, med_days_won: r1(median(daysWon)), med_days_lost: r1(median(daysLost)), lo: Number.isFinite(lo) ? lo : 0, hi: Number.isFinite(hi) ? hi : 0 }
}

/**
 * Win rate and velocity by engagement decile and level for a set of deals —
 * the prep's deal_table, exactly: deciles are equal-count bins over the score
 * rank (ties broken by order), levels are Low ≤30 < Medium ≤70 < High.
 */
export function dealGroup(deals: DecodedDeals, idx: number[]): DealGroup | null {
  if (idx.length < 20) return null
  const order = [...idx].sort((a, b) => deals.s[a] - deals.s[b] || a - b)
  const n = order.length
  const decBins: number[][] = Array.from({ length: 10 }, () => [])
  order.forEach((dealIndex, position) => {
    const rank = position + 1
    const bin = rank === 1 ? 0 : Math.max(0, Math.ceil(((rank - 1) * 10) / (n - 1)) - 1)
    decBins[Math.min(9, bin)].push(dealIndex)
  })
  const levelBins: number[][] = [[], [], []]
  for (const i of idx) levelBins[levelOf(deals.s[i])].push(i)
  const deciles = decBins.map((bin, k) => ({ dec: k + 1, ...bucket(deals, bin) })).filter((row) => row.n > 0)
  const levels = levelBins.map((bin, k) => ({ level: DEAL_LEVELS[k] as string, ...bucket(deals, bin) })).filter((row) => row.n > 0)
  let won = 0
  for (const i of idx) won += deals.w[i]
  const xs = deciles.map((row) => row.dec)
  const ys = deciles.map((row) => row.win_rate ?? 0)
  return { deciles, levels, n, win_rate: r1((won / n) * 100), r_win: deciles.length > 2 ? Math.round(correlation(xs, ys) * 100) / 100 : null }
}

function correlation(xs: number[], ys: number[]): number {
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my)
    dx += (xs[i] - mx) ** 2
    dy += (ys[i] - my) ** 2
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0
}

/** Deals of the default population: every type but renewals, transactional ones out. */
export function defaultDealIndices(deals: DecodedDeals, filter: (i: number) => boolean = () => true): number[] {
  const renewal = deals.types.map((type) => /renewal/i.test(type))
  const out: number[] = []
  for (let i = 0; i < deals.w.length; i += 1) if (!renewal[deals.t[i]] && !deals.x[i] && filter(i)) out.push(i)
  return out
}

// ---------------------------------------------------------------- summary

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

function pctChange(observation: number | null | undefined, baseline: number | null | undefined): number | null {
  if (observation === null || observation === undefined || !baseline) return null
  return round((observation / baseline - 1) * 100, 1)
}

/** The populations a cohort view compares. */
export function cohortPopulations(config: RoiRunConfig | null | undefined): string[] {
  return config?.cohort === 'users' ? ['User', 'Non-user'] : ['High', 'Medium', 'Low']
}

export type RoiFactsSummary = ReturnType<typeof summarizeFacts>

/**
 * What the analyst is given. With a run config, `configured` holds exactly
 * the windows the report opens on (observation, baseline, the same window a
 * year earlier) for every population, with the percent changes — the
 * numbers the narrative should cite.
 */
export function summarizeFacts(facts: RoiFacts, config?: RoiRunConfig | null) {
  const U = facts.U
  let activity: Record<string, unknown> | null = null
  let configured: Record<string, unknown> | null = null
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
    // Reps a row stands for: one, or a readout group row's weight (team and role rows are not cohorts).
    const reps = (user: (typeof U.users)[number]) => (user.k === 'org' || user.k === 'role' ? 0 : user.w ?? 1)
    const tierCounts = { High: 0, Medium: 0, Low: 0 }
    for (const user of U.users) if (user.t && user.t in tierCounts) tierCounts[user.t as keyof typeof tierCounts] += reps(user)
    activity = {
      months: { first: monthLabel(U.months[0]), last: monthLabel(U.months[U.months.length - 1]), count: U.months.length },
      windows: Object.fromEntries(Object.entries(W).filter(([, idx]) => idx.length).map(([name, idx]) => [name, `${monthLabel(U.months[idx[0]])} – ${monthLabel(U.months[idx[idx.length - 1]])}`])),
      metrics: U.labels,
      reps: facts.AGG ? facts.AGG.reps : U.users.reduce((sum, user) => sum + reps(user), 0),
      usage: U.hasUsage
        ? { matchedReps: U.nUsage, usageRecords: U.usageRecords, bottomFivePercent: U.nBottom, users: U.users.filter((u) => u.f === 'User').reduce((sum, user) => sum + reps(user), 0), tierCuts: U.tierCuts, tierCounts }
        : null,
      /** averages per rep per month; keys are metric ids, values by population then window */
      averagesPerRepPerMonth: byPopulation,
    }
    if (config) {
      const resolved = resolveWindows(U.months, config)
      const populations = ['all', ...(U.hasUsage ? cohortPopulations(config) : [])]
      const seniorKeys = ['director_meeting_count', 'vp_meeting_count', 'executive_meeting_count'].filter((key) => key in U.labels || key in (U.mx ?? {}))
      const all = popMask(U, 'all')
      configured = {
        observation: resolved.observationLabel,
        baseline: resolved.baselineLabel,
        yearAgo: resolved.yearAgoLabel,
        cohortView: config.cohort === 'users' ? 'users vs non-users' : 'high, medium and low adopters',
        byPopulation: Object.fromEntries(populations.map((pop) => {
          const mask = popMask(U, pop)
          const observation = winAvg(U, mask, resolved.observation)
          const baseline = winAvg(U, mask, resolved.baseline)
          const yearAgo = resolved.yearAgo.length ? winAvg(U, mask, resolved.yearAgo) : null
          return [pop, {
            observation: roundAverages(observation),
            baseline: roundAverages(baseline),
            ...(yearAgo ? { yearAgo: roundAverages(yearAgo) } : {}),
            changePct: Object.fromEntries(Object.keys(U.labels).map((key) => [key, pctChange(observation[key], baseline[key])])),
          }]
        })),
        seniorMix: seniorKeys.length
          ? Object.fromEntries([['observation', resolved.observation], ['baseline', resolved.baseline], ['yearAgo', resolved.yearAgo]]
              .filter(([, idx]) => (idx as number[]).length)
              .map(([name, idx]) => [name, roundAverages(winAvg(U, all, idx as number[], seniorKeys))]))
          : null,
      }
    }
  }
  const OPP = facts.OPP
  const deals = OPP
    ? Object.fromEntries(Object.entries(OPP).map(([type, tables]) => [type, {
        excludingTransactional: { n: tables.excl.n, winRate: tables.excl.win_rate, decileCorrelation: tables.excl.r_win, deciles: tables.excl.deciles, levels: tables.excl.levels },
        includingTransactional: tables.incl === tables.excl ? 'same as excluding (no cycle times)' : { n: tables.incl.n, winRate: tables.incl.win_rate, levels: tables.incl.levels },
      }]))
    : null
  let dealsByFiscalYear: Record<string, unknown> | null = null
  if (facts.DEALS && facts.DEALS.w.length) {
    const decodedDeals = decodeDeals(facts.DEALS)
    const fyOfMonth = decodedDeals.months.map((month) => fiscalPeriodOf(month, config?.fiscalYearStartMonth).fy)
    const years = [...new Set(fyOfMonth)].sort()
    dealsByFiscalYear = {
      fiscalYearStarts: config?.fiscalYearStartMonth ? ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][config.fiscalYearStartMonth - 1] : 'January (calendar years — no fiscal year start was set)',
      population: 'all deal types except renewals, transactional deals excluded',
      years: Object.fromEntries(years.map((fy) => {
        const group = dealGroup(decodedDeals, defaultDealIndices(decodedDeals, (i) => decodedDeals.m[i] >= 0 && fyOfMonth[decodedDeals.m[i]] === fy))
        return [fy, group ? { n: group.n, winRate: group.win_rate, levels: group.levels.map(({ level, n, win_rate, med_days_won, med_days_lost }) => ({ level, n, win_rate, med_days_won, med_days_lost })) } : 'fewer than 20 deals']
      })),
    }
  }
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
        ...(ST.cells?.length ? { heatmap: stagePersonaSignals(ST) } : {}),
      }
    : null
  const accounts = facts.ACC
    ? {
        accountsWithTwoPlusDeals: facts.ACC.nShown,
        accountsTotal: facts.ACC.nAccounts,
        engagementVsWinRateCorrelation: (() => {
          const rows = facts.ACC.accounts.filter((row) => row.eng !== null)
          return rows.length > 5 ? round(correlation(rows.map((row) => row.eng as number), rows.map((row) => row.win_rate)), 2) : null
        })(),
        byEngagementLevel: [0, 1, 2].map((level) => {
          const rows = facts.ACC!.accounts.filter((row) => row.eng !== null && levelOf(row.eng) === level)
          const opps = rows.reduce((a, row) => a + row.opps, 0)
          const won = rows.reduce((a, row) => a + row.won, 0)
          return { level: DEAL_LEVELS[level], accounts: rows.length, winRate: opps ? round((won / opps) * 100, 1) : null }
        }),
        largest: facts.ACC.accounts.slice(0, 8).map(({ account, opps, win_rate, eng, depth, breadth }) => ({ account, opps, win_rate, eng, depth, breadth })),
      }
    : null
  return {
    ...(configured ? { configured } : {}),
    activity,
    deals,
    ...(dealsByFiscalYear ? { dealsByFiscalYear } : {}),
    stages,
    ...(accounts ? { accounts } : {}),
    meta: facts.META,
    notes: facts.notes,
  }
}

/**
 * The stage × persona heatmap in numbers: per stage, how many activities
 * each persona averages on won and lost deals, and the win rate of deals
 * where the persona was present — plus the strongest and weakest signals.
 */
export function stagePersonaSignals(ST: NonNullable<RoiFacts['ST']>) {
  const cells = ST.cells ?? []
  const personas = ST.personaKeys ?? []
  const P = personas.length
  const stages = ST.stages.map((row) => row.stage)
  const agg = stages.map(() => ({ won: 0, lost: 0, wonActs: new Array(P).fill(0), lostActs: new Array(P).fill(0), wonWith: new Array(P).fill(0), allWith: new Array(P).fill(0) }))
  for (const cell of cells) {
    const [st, w, , , n] = cell
    const a = agg[st]
    if (!a) continue
    if (w) a.won += n
    else a.lost += n
    for (let k = 0; k < P; k += 1) {
      const acts = cell[6 + k]
      const present = cell[6 + P + k]
      if (w) { a.wonActs[k] += acts; a.wonWith[k] += present } else a.lostActs[k] += acts
      a.allWith[k] += present
    }
  }
  const combos: Array<{ stage: string; persona: string; winRatePct: number; deals: number }> = []
  const byStage = stages.map((stage, s) => {
    const a = agg[s]
    const total = a.won + a.lost
    personas.forEach((persona, k) => {
      if (a.allWith[k] >= 20) combos.push({ stage, persona, winRatePct: round((a.wonWith[k] / a.allWith[k]) * 100, 1) ?? 0, deals: a.allWith[k] })
    })
    return {
      stage,
      deals: total,
      winRatePct: total ? round((a.won / total) * 100, 1) : null,
      avgActsWon: Object.fromEntries(personas.map((persona, k) => [persona, a.won ? round(a.wonActs[k] / a.won, 1) : null])),
      avgActsLost: Object.fromEntries(personas.map((persona, k) => [persona, a.lost ? round(a.lostActs[k] / a.lost, 1) : null])),
    }
  })
  const post = new Set(ST.postStages)
  const preCombos = combos.filter((combo) => !post.has(combo.stage)).sort((a, b) => b.winRatePct - a.winRatePct)
  return {
    note: 'Deals present at a stage (one row per deal and stage); averages are activities per deal at that stage. Post-decision stages are shown but not read as signals.',
    byStage,
    strongestPreDecisionSignals: preCombos.slice(0, 5),
    weakestPreDecisionSignals: preCombos.slice(-3).reverse(),
  }
}

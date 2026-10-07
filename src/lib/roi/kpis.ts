import type { RoiFacts } from './prep'
import type { Account360Facts } from './account360/prep'
import type { RoiRunKpi } from './types'
import { resolveWindows, type RoiRunConfig } from './config'
import { cohortPopulations, dealGroup, decodeDeals, defaultDealIndices, popMask, winAvg } from './facts'

/**
 * The headline numbers a finished run records, so the page can lay an
 * account's runs side by side (a year-over-year refresh against the last
 * one). Fixed keys and labels: comparing runs means comparing like with like.
 */

function signedPct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '–'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

function change(observation: number | null | undefined, baseline: number | null | undefined): number | null {
  if (observation === null || observation === undefined || !baseline) return null
  return (observation / baseline - 1) * 100
}

function kpi(key: string, label: string, value: number | null, display: string): RoiRunKpi {
  return { key, label, value: value === null || !Number.isFinite(value) ? null : Math.round(value * 10) / 10, display: value === null || !Number.isFinite(value) ? '–' : display }
}

export function runKpis(facts: RoiFacts | null, a360: Account360Facts | null, config: RoiRunConfig): RoiRunKpi[] {
  const out: RoiRunKpi[] = []
  const U = facts?.U
  if (U) {
    const windows = resolveWindows(U.months, config)
    const all = popMask(U, 'all')
    const observation = winAvg(U, all, windows.observation)
    const baseline = winAvg(U, all, windows.baseline)
    const metric = (key: string, label: string) => {
      if (!(key in U.labels)) return
      const value = change(observation[key], baseline[key])
      out.push(kpi(key, `${label}, change`, value, signedPct(value)))
    }
    metric('meeting_count', 'Meetings per rep')
    metric('dir_vp_exec', 'Director+ meetings per rep')
    metric('people_engaged', 'People engaged per rep')
    metric('pipeline_created', 'Pipeline per rep')
    if (U.hasUsage) {
      const [top, , ...rest] = cohortPopulations(config)
      const bottom = config.cohort === 'users' ? 'Non-user' : rest[rest.length - 1] ?? 'Low'
      const high = winAvg(U, popMask(U, top), windows.observation, ['dir_vp_exec'])
      const low = winAvg(U, popMask(U, bottom), windows.observation, ['dir_vp_exec'])
      const lift = change(high.dir_vp_exec, low.dir_vp_exec)
      out.push(kpi('cohort_lift', config.cohort === 'users' ? 'Director+ meetings, users vs non-users' : 'Director+ meetings, high vs low adopters', lift, signedPct(lift)))
    }
  }
  if (facts?.DEALS && facts.DEALS.w.length) {
    const deals = decodeDeals(facts.DEALS)
    const group = dealGroup(deals, defaultDealIndices(deals))
    const low = group?.levels.find((row) => row.level.startsWith('Low'))
    const high = group?.levels.find((row) => row.level.startsWith('High'))
    if (high?.win_rate !== null && high?.win_rate !== undefined) out.push(kpi('win_high', 'Win rate, high engagement', high.win_rate, `${high.win_rate.toFixed(1)}%`))
    if (high?.win_rate && low?.win_rate) {
      const multiple = high.win_rate / low.win_rate
      out.push(kpi('win_lift', 'Win rate, high vs low engagement', multiple, `${multiple.toFixed(1)}×`))
    }
  } else if (facts?.OPP) {
    const table = facts.OPP['All (excl. renewals)']?.excl ?? Object.values(facts.OPP)[0]?.excl
    const low = table?.levels.find((row) => row.level.startsWith('Low'))
    const high = table?.levels.find((row) => row.level.startsWith('High'))
    if (high?.win_rate !== null && high?.win_rate !== undefined) out.push(kpi('win_high', 'Win rate, high engagement', high.win_rate, `${high.win_rate.toFixed(1)}%`))
    if (high?.win_rate && low?.win_rate) {
      const multiple = high.win_rate / low.win_rate
      out.push(kpi('win_lift', 'Win rate, high vs low engagement', multiple, `${multiple.toFixed(1)}×`))
    }
  }
  if (a360) {
    const power = a360.BUNDLE.cohorts_static.find((row) => row.cohort === 'Power Users')
    const none = a360.BUNDLE.cohorts_static.find((row) => row.cohort === 'No Engagement')
    if (power && none?.avg_created) {
      const multiple = power.avg_created / none.avg_created
      out.push(kpi('a360_lift', 'Pipeline per account, power users vs no engagement', multiple, `${multiple.toFixed(1)}×`))
    }
  }
  return out
}

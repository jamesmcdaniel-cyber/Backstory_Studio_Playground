import { z } from 'zod'
import type { RoiTimeframePreset } from './timeframe'

/**
 * How an ROI analysis is configured on the ROI analysis page, before it runs.
 *
 * Plain-English choices only: a window length, what to compare it with, and
 * (optionally) explicit baseline and observation months. Windows count back
 * from the newest full month in the data unless explicit months are given;
 * the data pulled is about two years, and the configuration slices it.
 *
 * A leaf module: the page's form, the API, the facts summary and the
 * dashboard renderer all read it, so it imports nothing from the server.
 */

export const ROI_WINDOW_MONTHS = [3, 6, 12] as const
export type RoiWindowMonths = (typeof ROI_WINDOW_MONTHS)[number]

export type RoiComparison = 'prior' | 'year_ago'
export type RoiCohortType = 'tiers' | 'users'
export type RoiMonthRange = { from: string; to: string }

export type RoiRunConfig = {
  windowMonths: RoiWindowMonths
  comparison: RoiComparison
  /** Explicit windows, replacing the counted-back ones. */
  custom?: { baseline: RoiMonthRange; observation: RoiMonthRange } | null
  cohort: RoiCohortType
  /** 1 = January. Optional — labels fiscal years and quarters for seasonality. */
  fiscalYearStartMonth?: number | null
}

export const DEFAULT_RUN_CONFIG: RoiRunConfig = { windowMonths: 6, comparison: 'prior', custom: null, cohort: 'tiers', fiscalYearStartMonth: null }

/** A window shorter than this is refused; one shorter than the ideal is allowed with a warning. */
export const ROI_MIN_WINDOW_MONTHS = 3
export const ROI_IDEAL_WINDOW_MONTHS = 6

export const ROI_WINDOW_OPTIONS: Array<{ value: RoiWindowMonths; label: string; hint?: string }> = [
  { value: 3, label: 'Last 3 months', hint: 'The minimum — trends are noisier' },
  { value: 6, label: 'Last 6 months', hint: 'Recommended' },
  { value: 12, label: 'Last 12 months' },
]

export const ROI_COMPARISON_OPTIONS: Array<{ value: RoiComparison; label: string; description: string }> = [
  { value: 'prior', label: 'The period before it', description: 'Last N months against the N months immediately before them.' },
  { value: 'year_ago', label: 'The same period last year', description: 'Last N months against the same months a year earlier — controls for seasonality.' },
]

export const ROI_COHORT_OPTIONS: Array<{ value: RoiCohortType; label: string; description: string }> = [
  { value: 'tiers', label: 'High, medium and low adopters', description: 'Reps split into thirds by how much they use Backstory.' },
  { value: 'users', label: 'Users vs non-users', description: 'Reps who use Backstory against those who do not.' },
]

export const ROI_REASON_PRESETS = ['QBR / EBR', 'Renewal', 'Churn risk', 'Expansion', 'Executive check-in'] as const

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

export function isMonthKey(value: unknown): value is string {
  return typeof value === 'string' && MONTH_RE.test(value)
}

export function monthIndex(month: string): number {
  const [year, mm] = month.split('-').map(Number)
  return year * 12 + (mm - 1)
}

export function monthKey(index: number): string {
  const year = Math.floor(index / 12)
  return `${year}-${String((index % 12) + 1).padStart(2, '0')}`
}

/** Inclusive count of months in a range. */
export function monthsInRange(range: RoiMonthRange): number {
  return monthIndex(range.to) - monthIndex(range.from) + 1
}

export function monthLabel(month: string): string {
  const [year, mm] = month.split('-')
  return `${MONTH_SHORT[Number(mm) - 1]} ${year}`
}

/** "Apr – Sep 2026" within a year, "Oct 2025 – Mar 2026" across one. */
export function rangeLabel(range: RoiMonthRange): string {
  if (range.from === range.to) return monthLabel(range.from)
  if (range.from.slice(0, 4) === range.to.slice(0, 4)) return `${MONTH_SHORT[Number(range.from.slice(5, 7)) - 1]} – ${monthLabel(range.to)}`
  return `${monthLabel(range.from)} – ${monthLabel(range.to)}`
}

const monthRangeSchema = z.object({
  from: z.string().refine(isMonthKey, 'Pick a start month.'),
  to: z.string().refine(isMonthKey, 'Pick an end month.'),
})

export const roiRunConfigSchema = z.object({
  windowMonths: z.union([z.literal(3), z.literal(6), z.literal(12)]).default(6),
  comparison: z.enum(['prior', 'year_ago']).default('prior'),
  custom: z.object({ baseline: monthRangeSchema, observation: monthRangeSchema }).nullable().optional(),
  cohort: z.enum(['tiers', 'users']).default('tiers'),
  fiscalYearStartMonth: z.number().int().min(1).max(12).nullable().optional(),
}).superRefine((config, ctx) => {
  if (!config.custom) return
  const { baseline, observation } = config.custom
  for (const [name, range] of [['baseline', baseline], ['observation', observation]] as const) {
    if (monthIndex(range.to) < monthIndex(range.from)) {
      ctx.addIssue({ code: 'custom', path: ['custom', name], message: `The ${name} period ends before it starts.` })
    } else if (monthsInRange(range) < ROI_MIN_WINDOW_MONTHS) {
      ctx.addIssue({ code: 'custom', path: ['custom', name], message: `The ${name} period needs at least ${ROI_MIN_WINDOW_MONTHS} months (${ROI_IDEAL_WINDOW_MONTHS} is ideal).` })
    }
  }
  if (monthIndex(baseline.to) >= monthIndex(observation.from)) {
    ctx.addIssue({ code: 'custom', path: ['custom'], message: 'The baseline period must end before the observation period starts.' })
  }
})

/** The config as stored, or the defaults when a row predates the page. */
export function readRunConfig(value: unknown): RoiRunConfig {
  const parsed = roiRunConfigSchema.safeParse(value ?? {})
  return parsed.success ? { ...DEFAULT_RUN_CONFIG, ...parsed.data } : { ...DEFAULT_RUN_CONFIG }
}

/** Plain-English warnings that do not block a run (a short window). */
export function runConfigWarnings(config: RoiRunConfig): string[] {
  const warnings: string[] = []
  const lengths = config.custom ? [monthsInRange(config.custom.baseline), monthsInRange(config.custom.observation)] : [config.windowMonths]
  if (lengths.some((length) => length < ROI_IDEAL_WINDOW_MONTHS)) warnings.push(`Windows shorter than ${ROI_IDEAL_WINDOW_MONTHS} months make trends noisier; ${ROI_IDEAL_WINDOW_MONTHS} is ideal.`)
  if (config.custom && monthsInRange(config.custom.baseline) !== monthsInRange(config.custom.observation)) warnings.push('The baseline and observation periods are different lengths; averages are per rep per month, so they still compare.')
  return warnings
}

/** The older timeframe preset closest to a config (what pre-page code reads). */
export function presetFor(config: RoiRunConfig): RoiTimeframePreset {
  if (config.comparison === 'year_ago') return 'last6_vs_year_ago'
  if (config.windowMonths === 12) return 'last12_vs_prior12'
  if (config.windowMonths === 3) return 'last3_vs_prior3'
  return 'last6_vs_prior6'
}

/** A config from an older preset (analyses started before the page). */
export function configFromPreset(preset: string | null | undefined): RoiRunConfig {
  switch (preset) {
    case 'last6_vs_year_ago': return { ...DEFAULT_RUN_CONFIG, comparison: 'year_ago' }
    case 'last12_vs_prior12': return { ...DEFAULT_RUN_CONFIG, windowMonths: 12 }
    case 'last3_vs_prior3': return { ...DEFAULT_RUN_CONFIG, windowMonths: 3 }
    default: return { ...DEFAULT_RUN_CONFIG }
  }
}

export function comparisonLabel(config: RoiRunConfig): string {
  if (config.custom) return `${rangeLabel(config.custom.observation)} vs ${rangeLabel(config.custom.baseline)}`
  const n = config.windowMonths
  return config.comparison === 'year_ago' ? `Last ${n} months vs the same ${n} last year` : `Last ${n} months vs the ${n} before`
}

/** One line per setting, for run history and the report's Method tab. */
export function describeRunConfig(config: RoiRunConfig): string[] {
  return [
    comparisonLabel(config),
    config.cohort === 'users' ? 'Cohorts: users vs non-users' : 'Cohorts: high, medium and low adopters',
    ...(config.fiscalYearStartMonth ? [`Fiscal year starts in ${MONTH_NAMES[config.fiscalYearStartMonth - 1]}`] : []),
  ]
}

export type ResolvedWindows = {
  /** Indices into the data's month list. */
  observation: number[]
  baseline: number[]
  /** The observation window a year earlier, when the data reaches back that far. */
  yearAgo: number[]
  observationLabel: string
  baselineLabel: string
  yearAgoLabel: string | null
}

function indicesOf(months: string[], from: number, to: number): number[] {
  const out: number[] = []
  months.forEach((month, index) => {
    const at = monthIndex(month)
    if (at >= from && at <= to) out.push(index)
  })
  return out
}

function labelOf(months: string[], idx: number[]): string {
  return idx.length ? rangeLabel({ from: months[idx[0]], to: months[idx[idx.length - 1]] }) : 'no months in the data'
}

/**
 * The windows a config picks out of the data's months (sorted YYYY-MM).
 * Counted back from the newest month unless explicit months were chosen;
 * a window the data does not reach comes back empty rather than shifted.
 */
export function resolveWindows(months: string[], config: RoiRunConfig): ResolvedWindows {
  if (!months.length) return { observation: [], baseline: [], yearAgo: [], observationLabel: '', baselineLabel: '', yearAgoLabel: null }
  let obsFrom: number
  let obsTo: number
  let baseFrom: number
  let baseTo: number
  if (config.custom) {
    obsFrom = monthIndex(config.custom.observation.from)
    obsTo = monthIndex(config.custom.observation.to)
    baseFrom = monthIndex(config.custom.baseline.from)
    baseTo = monthIndex(config.custom.baseline.to)
  } else {
    const n = config.windowMonths
    obsTo = monthIndex(months[months.length - 1])
    obsFrom = obsTo - n + 1
    if (config.comparison === 'year_ago') {
      baseFrom = obsFrom - 12
      baseTo = obsTo - 12
    } else {
      baseTo = obsFrom - 1
      baseFrom = baseTo - n + 1
    }
  }
  const observation = indicesOf(months, obsFrom, obsTo)
  const baseline = indicesOf(months, baseFrom, baseTo)
  const yearAgo = indicesOf(months, obsFrom - 12, obsTo - 12)
  return {
    observation,
    baseline,
    yearAgo,
    observationLabel: labelOf(months, observation),
    baselineLabel: labelOf(months, baseline),
    yearAgoLabel: yearAgo.length ? labelOf(months, yearAgo) : null,
  }
}

/**
 * The fiscal year and quarter a month falls in. A fiscal year is named for
 * the calendar year it ends in (a February start makes Feb 2025 – Jan 2026
 * FY2026); with a January start it is the calendar year.
 */
export function fiscalPeriodOf(month: string, startMonth: number | null | undefined): { fy: string; fq: string } {
  const [year, mm] = month.split('-').map(Number)
  const start = startMonth && startMonth >= 1 && startMonth <= 12 ? startMonth : 1
  const offset = (mm - start + 12) % 12
  const fyYear = start === 1 ? year : mm >= start ? year + 1 : year
  return { fy: `FY${fyYear}`, fq: `Q${Math.floor(offset / 3) + 1}` }
}

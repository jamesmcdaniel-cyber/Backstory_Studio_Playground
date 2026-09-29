/**
 * Time frames for an ROI analysis, as plain-English choices — never a date
 * syntax the user has to get right. Each preset resolves to an observation
 * window and a baseline window relative to the newest month in the data,
 * which the agent determines at run time.
 */

export type RoiTimeframePreset = 'last6_vs_prior6' | 'last6_vs_year_ago' | 'last12_vs_prior12' | 'last3_vs_prior3'

export type RoiTimeframe = {
  preset: RoiTimeframePreset
}

export const ROI_TIMEFRAMES: Array<{ preset: RoiTimeframePreset; label: string; description: string }> = [
  { preset: 'last6_vs_prior6', label: 'Last 6 months vs prior 6', description: 'The most recent six months against the six before them.' },
  { preset: 'last6_vs_year_ago', label: 'Last 6 months vs same period last year', description: 'The most recent six months against the same six months a year earlier.' },
  { preset: 'last12_vs_prior12', label: 'Last 12 months vs prior 12', description: 'A full year against the year before it.' },
  { preset: 'last3_vs_prior3', label: 'Last quarter vs prior quarter', description: 'The most recent three months against the three before them.' },
]

export function isRoiTimeframePreset(value: unknown): value is RoiTimeframePreset {
  return typeof value === 'string' && ROI_TIMEFRAMES.some((option) => option.preset === value)
}

export function timeframeLabel(timeframe: RoiTimeframe | null | undefined): string {
  return ROI_TIMEFRAMES.find((option) => option.preset === timeframe?.preset)?.label ?? 'Last 6 months vs prior 6'
}

/** How the agent is told to cut the data — in words, derived from the data's newest month. */
export function timeframeInstruction(timeframe: RoiTimeframe): string {
  switch (timeframe.preset) {
    case 'last6_vs_year_ago':
      return 'OBSERVATION = the newest 6 full months in the activity extract. BASELINE = the same 6 calendar months one year earlier.'
    case 'last12_vs_prior12':
      return 'OBSERVATION = the newest 12 full months in the activity extract. BASELINE = the 12 months immediately before them.'
    case 'last3_vs_prior3':
      return 'OBSERVATION = the newest 3 full months in the activity extract. BASELINE = the 3 months immediately before them.'
    case 'last6_vs_prior6':
    default:
      return 'OBSERVATION = the newest 6 full months in the activity extract. BASELINE = the 6 months immediately before them.'
  }
}

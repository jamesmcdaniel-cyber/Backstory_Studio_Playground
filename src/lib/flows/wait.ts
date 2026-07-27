/**
 * Pure timing math for the `wait` node's timer modes (duration / until). The
 * interpreter resolves any {{tokens}} in amount/until first, then calls
 * computeResumeAt with the run's frozen clock as `nowMs`; the result feeds
 * FlowRun.resumeAt so the cron scan can wake the run when it's due. The webhook
 * mode has no resume time and is handled by the interpreter directly.
 */

export const WAIT_UNITS = ['seconds', 'minutes', 'hours', 'days'] as const
export type WaitUnit = (typeof WAIT_UNITS)[number]

const UNIT_MS: Record<WaitUnit, number> = {
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
}

export function unitMs(unit: WaitUnit): number {
  return UNIT_MS[unit]
}

export type WaitTimingInput = {
  mode: 'duration' | 'until' | 'webhook'
  amount?: string
  unit?: WaitUnit
  until?: string
}

/**
 * The absolute wall-clock ms when a timer wait should resume, or a plain-english
 * error. `nowMs` is the run's frozen clock. A past `until` clamps to now so the
 * run resumes on the next scan instead of being stuck forever.
 */
export function computeResumeAt(nowMs: number, data: WaitTimingInput): { resumeAtMs: number } | { error: string } {
  if (data.mode === 'until') {
    const raw = (data.until ?? '').trim()
    if (!raw) return { error: 'This wait needs a date/time to wait until.' }
    const parsed = Date.parse(raw)
    if (Number.isNaN(parsed)) return { error: `This wait couldn't read "${raw}" as a date/time.` }
    return { resumeAtMs: Math.max(nowMs, parsed) }
  }
  // duration
  const raw = (data.amount ?? '').trim()
  const amount = Number(raw)
  if (!raw || !Number.isFinite(amount)) return { error: `This wait needs a number for how long to wait — "${raw}" isn't one.` }
  if (amount < 0) return { error: 'This wait needs a non-negative amount.' }
  return { resumeAtMs: nowMs + amount * unitMs(data.unit ?? 'minutes') }
}

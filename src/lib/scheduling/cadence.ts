/**
 * Plain-English cadence layer over the backend schedule types (see due.ts).
 * The product never shows or accepts raw cron — users pick a friendly cadence
 * and we store the equivalent schedule (day-of-week and sub-daily cadences are
 * represented as crons internally, invisibly). Client-safe: no dependencies
 * beyond the pure due.ts types.
 */

export type Cadence = 'every15min' | 'every30min' | 'hourly' | 'daily' | 'daysofweek' | 'once'

export const DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const

/** A partial schedule shape good enough to classify — both agents and flow
 *  triggers store this. `type` is a plain string because flow triggers keep it
 *  loosely typed; unknown values classify as the flexible days-of-week picker. */
export type ScheduleLike = {
  type?: string
  time?: string
  cron?: string
  timezone?: string
  runAt?: string
  isActive?: boolean
}

/** Today as YYYY-MM-DD in local time — the earliest selectable one-time date. */
export function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** HH:MM + selected weekdays → a `mm hh * * d,d` cron. */
export function dowCron(time: string, days: number[]): string {
  const [hh, mm] = (time || '09:00').split(':').map((n) => parseInt(n, 10))
  const list = days.length ? [...days].sort((a, b) => a - b).join(',') : '1'
  return `${Number.isNaN(mm) ? 0 : mm} ${Number.isNaN(hh) ? 9 : hh} * * ${list}`
}

/** Parse the selected weekdays out of a cron's 5th field, defaulting to
 *  weekdays when the field is absent or not a plain day list (e.g. a legacy
 *  arbitrary cron) so the "days of week" picker always has a sane selection. */
export function daysFromCron(cron: string | undefined): number[] {
  const dow = (cron || '').trim().split(/\s+/)[4]
  if (!dow) return [1, 2, 3, 4, 5]
  const parsed = dow.split(',').map((n) => parseInt(n, 10)).filter((n) => n >= 0 && n <= 6)
  return parsed.length ? parsed : [1, 2, 3, 4, 5]
}

/** Pull HH:MM out of a cron's minute+hour fields for the time input. */
export function cronToTime(cron: string): string {
  const [minF, hourF] = (cron || '').trim().split(/\s+/)
  const mm = parseInt(minF, 10)
  const hh = parseInt(hourF, 10)
  if (Number.isNaN(mm) || Number.isNaN(hh)) return '09:00'
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

/** Classify a stored schedule into the cadence the pickers show. */
export function cadenceOf(schedule: ScheduleLike): Cadence {
  if (schedule.type === 'once') return 'once'
  if (schedule.type === 'daily') return 'daily'
  if (schedule.type === 'hourly') return 'hourly'
  if (schedule.type === 'cron') {
    const [minF, hourF, , , dowF] = (schedule.cron || '').trim().split(/\s+/)
    if (hourF === '*' && (dowF === '*' || dowF === undefined)) {
      if (minF === '*/15') return 'every15min'
      if (minF === '*/30') return 'every30min'
      return 'hourly'
    }
  }
  // Everything else recurring — day-of-week crons plus legacy weekly /
  // arbitrary crons — surfaces as the flexible "days of week" picker; a legacy
  // schedule converts to a clean representation on its next save.
  return 'daysofweek'
}

/** Build the stored schedule for a picked cadence (always active). */
export function scheduleForCadence(
  cadence: Cadence,
  current: ScheduleLike,
  fallback: { time: string; timezone: string; runAt: string; days: number[] },
): ScheduleLike {
  const time = fallback.time
  const timezone = current.timezone || fallback.timezone
  switch (cadence) {
    case 'daily':
      return { type: 'daily', time, timezone, isActive: true }
    case 'once':
      return { type: 'once', runAt: current.runAt || fallback.runAt, time, timezone, isActive: true }
    case 'every15min':
      return { type: 'cron', cron: '*/15 * * * *', time, timezone, isActive: true }
    case 'every30min':
      return { type: 'cron', cron: '*/30 * * * *', time, timezone, isActive: true }
    case 'hourly':
      return { type: 'cron', cron: '0 * * * *', time, timezone, isActive: true }
    case 'daysofweek':
      return { type: 'cron', cron: dowCron(time, fallback.days.length ? fallback.days : [1, 2, 3, 4, 5]), time, timezone, isActive: true }
  }
}

/**
 * A stored schedule in plain English (no timezone/paused suffix — callers
 * append those). Never prints cron syntax: unrecognized legacy crons read as
 * "a custom schedule".
 */
export function describeSchedule(schedule: ScheduleLike): string {
  const time = schedule.type === 'cron' ? cronToTime(schedule.cron || '') : schedule.time || '09:00'
  switch (schedule.type) {
    case undefined:
    case 'manual':
      return 'manual'
    case 'hourly':
      return 'every hour, on the hour'
    case 'daily':
      return `every day at ${time}`
    case 'weekly':
      return `weekly at ${time}`
    case 'once':
      return `once on ${schedule.runAt || 'a chosen date'} at ${time}`
    case 'cron': {
      const cadence = cadenceOf(schedule)
      if (cadence === 'every15min') return 'every 15 minutes'
      if (cadence === 'every30min') return 'every 30 minutes'
      if (cadence === 'hourly') return 'every hour, on the hour'
      const [minF, hourF] = (schedule.cron || '').trim().split(/\s+/)
      if (Number.isNaN(parseInt(minF, 10)) || Number.isNaN(parseInt(hourF, 10))) return 'a custom schedule'
      const days = daysFromCron(schedule.cron)
      const names = [...days].sort((a, b) => a - b).map((d) => DAY_LABELS[d]).join(', ')
      return `${names} at ${time}`
    }
    default:
      return 'a custom schedule'
  }
}

/**
 * True when this cron is one of the shapes our pickers generate (sub-hourly,
 * hourly, or a day-of-week list) — the shapes for which a minute-scanning
 * next-occurrence search is guaranteed to terminate within days, so it is
 * safe to compute in the UI. Arbitrary legacy crons (e.g. yearly dates) can
 * take a very long scan and get a static label instead.
 */
export function isPickerCron(cron: string | undefined): boolean {
  return /^(\*\/15|\*\/30|\d{1,2}) (\*|\d{1,2}) \* \* (\*|[\d,]+)$/.test((cron || '').trim())
}

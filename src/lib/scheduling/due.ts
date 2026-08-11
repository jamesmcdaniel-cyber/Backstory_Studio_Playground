/**
 * Pure, side-effect-free scheduling due-check.
 * No external dependencies — uses only built-in Intl APIs.
 */

export type AgentSchedule = {
  type: 'manual' | 'hourly' | 'daily' | 'weekly' | 'cron' | 'once'
  /** HH:MM – used by daily, weekly, and once */
  time: string
  /** Standard 5-field cron expression – used by type === 'cron' */
  cron: string
  /** IANA timezone string, e.g. "America/New_York" */
  timezone: string
  /** YYYY-MM-DD calendar date – used only by type === 'once' (with `time`). */
  runAt?: string
  isActive: boolean
  /**
   * ISO timestamp of when this schedule was configured (stamped by
   * `anchorSchedule` at save time). Occurrences from before the anchor are
   * never owed — without it, saving "daily at 09:00" at 15:00 fired instantly
   * as a catch-up run instead of waiting for tomorrow's 09:00. Absent on
   * schedules saved before anchoring existed, which keep catch-up behavior.
   */
  anchor?: string
}

/** The schedule's anchor as a Date, or null when absent/unparseable. */
function anchorDate(schedule: AgentSchedule): Date | null {
  if (!schedule.anchor) return null
  const parsed = new Date(schedule.anchor)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * lastExecutedAt floored by the anchor: for dueness, the schedule owes nothing
 * from before it was configured, so a fresh schedule behaves as if it "ran"
 * at save time and the first real run lands on the next occurrence.
 */
function effectiveLast(schedule: AgentSchedule, lastExecutedAt: Date | null): Date | null {
  const anchor = anchorDate(schedule)
  if (!anchor) return lastExecutedAt
  return lastExecutedAt && lastExecutedAt > anchor ? lastExecutedAt : anchor
}

/**
 * Returns `next` with its anchor maintained: a new schedule — or one whose
 * scheduling-relevant fields changed, including reactivation — gets a fresh
 * anchor at now; an unchanged schedule keeps the previous anchor so unrelated
 * edits never shift the cadence. Every path that writes a schedule must pass
 * it through here.
 */
export function anchorSchedule<T extends { type?: string; isActive?: boolean }>(
  next: T,
  previous?: unknown,
): T & { anchor?: string } {
  const prev =
    previous && typeof previous === 'object' && !Array.isArray(previous)
      ? (previous as Record<string, unknown>)
      : null
  const n = next as Record<string, unknown>
  const unchanged =
    prev !== null &&
    prev.type === n.type &&
    (prev.time ?? '') === (n.time ?? '') &&
    (prev.cron ?? '') === (n.cron ?? '') &&
    (prev.timezone ?? 'UTC') === (n.timezone ?? 'UTC') &&
    (prev.runAt ?? '') === (n.runAt ?? '') &&
    prev.isActive === n.isActive
  const anchor = unchanged ? (typeof prev.anchor === 'string' ? prev.anchor : undefined) : new Date().toISOString()
  return { ...next, anchor }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reads the current date-time components for a given instant in the supplied
 * IANA timezone, using Intl.DateTimeFormat.
 */
function zoneParts(instant: Date, tz: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const p = fmt.formatToParts(instant)
  const get = (type: string) => Number(p.find((x) => x.type === type)!.value)
  return {
    year: get('year'),
    month: get('month'),   // 1-based
    day: get('day'),
    hour: get('hour'),     // 0–23
    minute: get('minute'),
    second: get('second'),
    // day-of-week 0 (Sun)–6 (Sat)
    dow: new Date(get('year'), get('month') - 1, get('day')).getDay(),
  }
}

/**
 * Returns the UTC timestamp for HH:MM on the given Y/M/D (1-based month) in the
 * supplied timezone. Constructs the naive UTC instant with the target wall-clock
 * fields, then measures how far off Intl reports it in the zone and corrects —
 * so DST offsets and half-hour zones resolve to the right instant.
 */
function instantForDate(year: number, month: number, day: number, hhmm: string, tz: string): Date {
  const [hh, mm] = hhmm.split(':').map(Number)
  const naive = Date.UTC(year, month - 1, day, hh, mm, 0, 0)
  const check = zoneParts(new Date(naive), tz)
  const diffMs = ((hh - check.hour) * 60 + (mm - check.minute)) * 60_000
  return new Date(naive + diffMs)
}

/**
 * Returns the UTC timestamp for HH:MM today in the given timezone.
 * "Today" is determined by what `now` looks like in that zone.
 */
function todayInstant(hhmm: string, tz: string, now: Date): Date {
  const p = zoneParts(now, tz)
  return instantForDate(p.year, p.month, p.day, hhmm, tz)
}

// ---------------------------------------------------------------------------
// Minimal 5-field cron matcher
// Supports: * | */n | comma lists | ranges (a-b) for each field
// Fields: minute hour dom month dow
// ---------------------------------------------------------------------------

function matchField(expr: string, value: number, min: number, _max: number): boolean {
  for (const part of expr.split(',')) {
    if (part === '*') return true
    if (part.startsWith('*/')) {
      const step = parseInt(part.slice(2), 10)
      if (!isNaN(step) && step > 0 && (value - min) % step === 0) return true
    } else if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number)
      if (value >= lo && value <= hi) return true
    } else {
      if (parseInt(part, 10) === value) return true
    }
  }
  return false
}

/**
 * Returns true if `now` matches the 5-field cron expression
 * (evaluated in the given timezone).
 */
function matchesCron(expr: string, tz: string, now: Date): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const [minF, hourF, domF, monF, dowF] = fields
  const p = zoneParts(now, tz)
  return (
    matchField(minF, p.minute, 0, 59) &&
    matchField(hourF, p.hour, 0, 23) &&
    matchField(domF, p.day, 1, 31) &&
    matchField(monF, p.month, 1, 12) &&
    matchField(dowF, p.dow, 0, 6)
  )
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Returns true when the agent with the given schedule is due to run.
 *
 * Pure function — has no side effects; safe to call in tight loops.
 */
export function isDue(
  schedule: AgentSchedule,
  lastExecutedAt: Date | null,
  now: Date,
): boolean {
  if (!schedule.isActive) return false
  if (schedule.type === 'manual') return false

  switch (schedule.type) {
    case 'once': {
      // A one-time run: due once its target instant has passed and it has never
      // run. lastExecutedAt being set after the first run makes it never fire
      // again. runAt is a YYYY-MM-DD date paired with `time` in `timezone`.
      if (!schedule.runAt) return false
      const [y, mo, d] = schedule.runAt.split('-').map(Number)
      if (!y || !mo || !d) return false
      const target = instantForDate(y, mo, d, schedule.time || '09:00', schedule.timezone || 'UTC')
      if (now < target) return false
      // A target that had already passed when the schedule was saved is stale
      // configuration, not a missed run — never fire it.
      const anchor = anchorDate(schedule)
      if (anchor && anchor > target) return false
      return lastExecutedAt === null
    }

    case 'hourly': {
      const last = effectiveLast(schedule, lastExecutedAt)
      if (last === null) return true
      return now.getTime() - last.getTime() >= 60 * 60_000
    }

    case 'daily': {
      const scheduled = todayInstant(schedule.time || '00:00', schedule.timezone || 'UTC', now)
      if (now < scheduled) return false
      const last = effectiveLast(schedule, lastExecutedAt)
      if (last === null) return true
      return last < scheduled
    }

    case 'weekly': {
      const last = effectiveLast(schedule, lastExecutedAt)
      if (last !== null) {
        const sevenDaysMs = 7 * 24 * 60 * 60_000
        if (now.getTime() - last.getTime() < sevenDaysMs) return false
      }
      // Also require that now is past today's scheduled time
      const scheduled = todayInstant(schedule.time || '00:00', schedule.timezone || 'UTC', now)
      if (now < scheduled) return false
      return true
    }

    case 'cron': {
      if (!schedule.cron) return false
      const tz = schedule.timezone || 'UTC'

      // Catch-up based: the agent is due if ANY cron-matching minute exists in
      // the window (since, now]. This means an infrequent dispatch tick still
      // fires a cron like "0 9 * * *" even when the tick minute is not 09:00.
      //
      // since = lastExecutedAt ?? (now - 25h). Clamp the scan so we never
      // iterate more than 400 days of minutes (cap `since` to now - 400 days).
      const MINUTE_MS = 60_000
      const DEFAULT_LOOKBACK_MS = 25 * 60 * 60 * 1000 // 25h
      const MAX_LOOKBACK_MS = 400 * 24 * 60 * 60 * 1000 // 400 days

      const last = effectiveLast(schedule, lastExecutedAt)
      const sinceMs = last ? last.getTime() : now.getTime() - DEFAULT_LOOKBACK_MS
      const flooredSince = Math.max(sinceMs, now.getTime() - MAX_LOOKBACK_MS)

      // Iterate minute-by-minute from `now` backward to (but not including)
      // `since`, truncating seconds/millis. `(since, now]` is half-open at the
      // start, so we stop once the candidate minute is <= since.
      let cursor = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS
      while (cursor > flooredSince) {
        if (matchesCron(schedule.cron, tz, new Date(cursor))) return true
        cursor -= MINUTE_MS
      }
      return false
    }

    default:
      return false
  }
}

/**
 * WHICH occurrence is owed right now, where `isDue` reports only WHETHER one is.
 *
 * Its value becomes `FlowRun.scheduledFor` and the scheduled agent's
 * idempotency key, so two concurrent ticks that both notice the same owed
 * occurrence compute the SAME instant and the unique index rejects the second.
 * Before this, duplicate protection was a read-then-act check (blocksSchedule)
 * that cannot stop a true race.
 *
 * CONTRACT: returns non-null exactly when `isDue` returns true for the same
 * inputs. The leading `isDue` call guarantees that by construction, and a
 * property test pins it — if you change one, change both.
 *
 * Pure function — no side effects.
 */
export function dueOccurrence(
  schedule: AgentSchedule,
  lastExecutedAt: Date | null,
  now: Date,
): Date | null {
  if (!isDue(schedule, lastExecutedAt, now)) return null
  const MINUTE_MS = 60_000
  const HOUR_MS = 60 * MINUTE_MS

  switch (schedule.type) {
    case 'once': {
      const [y, mo, d] = (schedule.runAt ?? '').split('-').map(Number)
      return instantForDate(y, mo, d, schedule.time || '09:00', schedule.timezone || 'UTC')
    }

    case 'hourly':
      // Hourly has NO grid: isDue defines it as "60 real minutes since the last
      // run", so there is no true occurrence instant to name. The hour-floor of
      // `now` is stable across ticks minutes apart, which is all the constraint
      // needs. Documented approximation — see the design doc.
      return new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS)

    case 'daily':
    case 'weekly':
      return todayInstant(schedule.time || '00:00', schedule.timezone || 'UTC', now)

    case 'cron': {
      // The LATEST matching minute in the same window isDue scanned, so a tick
      // at 13:07 for "0 9 * * *" reports 09:00 — the occurrence — not 13:07.
      const tz = schedule.timezone || 'UTC'
      const DEFAULT_LOOKBACK_MS = 25 * 60 * 60 * 1000
      const MAX_LOOKBACK_MS = 400 * 24 * 60 * 60 * 1000
      const last = effectiveLast(schedule, lastExecutedAt)
      const sinceMs = last ? last.getTime() : now.getTime() - DEFAULT_LOOKBACK_MS
      const flooredSince = Math.max(sinceMs, now.getTime() - MAX_LOOKBACK_MS)
      let cursor = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS
      while (cursor > flooredSince) {
        if (matchesCron(schedule.cron, tz, new Date(cursor))) return new Date(cursor)
        cursor -= MINUTE_MS
      }
      return null
    }

    default:
      return null
  }
}

/**
 * Returns the next UTC instant strictly after `from` at which the schedule
 * fires, or null if it never will (manual, inactive, or a passed `once`).
 *
 * Mirrors `isDue`'s per-type semantics, but since this function has no
 * `lastExecutedAt` input it treats `from` as the anchor point for types whose
 * `isDue` behavior depends on elapsed time since the last run (hourly,
 * weekly).
 *
 * Pure function — has no side effects; safe to call in tight loops.
 */
export function nextOccurrence(schedule: AgentSchedule, from: Date): Date | null {
  if (!schedule.isActive) return null
  if (schedule.type === 'manual') return null

  switch (schedule.type) {
    case 'once': {
      // Mirrors isDue's once: target = runAt + time in timezone. Unlike isDue
      // (which also checks lastExecutedAt === null), nextOccurrence has no
      // execution history — it simply reports the target if it is still
      // ahead of `from`, else null (it has passed).
      if (!schedule.runAt) return null
      const [y, mo, d] = schedule.runAt.split('-').map(Number)
      if (!y || !mo || !d) return null
      const target = instantForDate(y, mo, d, schedule.time || '09:00', schedule.timezone || 'UTC')
      // Mirror isDue: a target already passed at save time never fires.
      const anchor = anchorDate(schedule)
      if (anchor && anchor > target) return null
      return target > from ? target : null
    }

    case 'hourly': {
      // isDue's hourly convention: due immediately when never run, else 60
      // real minutes after lastExecutedAt — no alignment to the top of the
      // hour. Treating `from` as that anchor, the next occurrence is exactly
      // `from` + 60 minutes.
      return new Date(from.getTime() + 60 * 60_000)
    }

    case 'daily': {
      const tz = schedule.timezone || 'UTC'
      const time = schedule.time || '00:00'
      const scheduled = todayInstant(time, tz, from)
      if (scheduled > from) return scheduled
      const p = zoneParts(from, tz)
      return instantForDate(p.year, p.month, p.day + 1, time, tz)
    }

    case 'weekly': {
      // isDue's weekly convention has no stored day-of-week — it only gates
      // on >=7 days since lastExecutedAt (or null) plus today's scheduled
      // time having passed. Mirroring that with `from` as the anchor: this
      // week's scheduled instant if still ahead, else the same wall-clock
      // time 7 days out.
      const tz = schedule.timezone || 'UTC'
      const time = schedule.time || '00:00'
      const scheduled = todayInstant(time, tz, from)
      if (scheduled > from) return scheduled
      const p = zoneParts(from, tz)
      return instantForDate(p.year, p.month, p.day + 7, time, tz)
    }

    case 'cron': {
      if (!schedule.cron) return null
      const tz = schedule.timezone || 'UTC'

      // Scan forward minute-by-minute from `from + 1min`, evaluating the
      // existing matcher against zoned wall-clock parts exactly as isDue
      // does. Floor `from` to a minute boundary first so the scan always
      // starts strictly after `from` regardless of its seconds/ms. Cap the
      // scan at 370 days out — if nothing matches, return null.
      const MINUTE_MS = 60_000
      const MAX_SCAN_MS = 370 * 24 * 60 * 60 * 1000
      const flooredFrom = Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS
      const deadline = from.getTime() + MAX_SCAN_MS

      let cursor = flooredFrom + MINUTE_MS
      while (cursor <= deadline) {
        if (matchesCron(schedule.cron, tz, new Date(cursor))) return new Date(cursor)
        cursor += MINUTE_MS
      }
      return null
    }

    default:
      return null
  }
}

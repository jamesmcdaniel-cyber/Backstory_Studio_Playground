import { describe, it, test } from 'node:test'
import assert from 'node:assert/strict'
import { anchorSchedule, isDue, nextOccurrence, type AgentSchedule } from '../due.js'

// --- helpers -----------------------------------------------------------------

function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60 * 1000)
}

function hoursAgo(n: number): Date {
  return new Date(Date.now() - n * 60 * 60 * 1000)
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000)
}

/**
 * Returns a `now` Date that represents HH:MM in the given timezone.
 * Builds an absolute instant by parsing what Intl says "today" is in that zone
 * and adding the desired offset.
 */
function nowAtTime(hh: number, mm: number, tz: string): Date {
  // We'll iterate second-by-second... instead, compute it directly.
  // Use a known reference: get today's midnight in the target timezone.
  const ref = new Date()
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(ref)
  const year = Number(parts.find((p) => p.type === 'year')!.value)
  const month = Number(parts.find((p) => p.type === 'month')!.value)
  const day = Number(parts.find((p) => p.type === 'day')!.value)

  // The scheduled instant as a UTC date.
  // Find the UTC offset for the zone at this particular moment by comparing
  // what the zone thinks the date is versus UTC.
  const utcMidnight = Date.UTC(year, month - 1, day)

  // Build an approximation: utcMidnight is midnight *as UTC values* but not
  // necessarily midnight in the target timezone.  We need to find the UTC
  // instant that corresponds to hh:mm in the target zone on *that* local day.
  //
  // Strategy: start from utcMidnight + desired local minutes, then correct
  // for the zone offset by checking what Intl thinks the time is.
  const candidateMs = utcMidnight + (hh * 60 + mm) * 60 * 1000
  const candidate = new Date(candidateMs)
  // Read back what time Intl reports for candidate in tz.
  const timeParts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(candidate)
  const actualHH = Number(timeParts.find((p) => p.type === 'hour')!.value)
  const actualMM = Number(timeParts.find((p) => p.type === 'minute')!.value)
  // Adjust by the difference (handles fixed offsets correctly).
  const diffMs = ((hh - actualHH) * 60 + (mm - actualMM)) * 60 * 1000
  return new Date(candidateMs + diffMs)
}

// --- tests -------------------------------------------------------------------

describe('isDue', () => {
  // 1. manual schedule → always false
  it('returns false for manual schedule', () => {
    const schedule: AgentSchedule = {
      type: 'manual',
      time: '09:00',
      cron: '',
      timezone: 'UTC',
      isActive: true,
    }
    assert.equal(isDue(schedule, null, new Date()), false)
    assert.equal(isDue(schedule, minutesAgo(120), new Date()), false)
  })

  // 2. inactive schedule → always false
  it('returns false when isActive is false', () => {
    const schedule: AgentSchedule = {
      type: 'hourly',
      time: '00:00',
      cron: '',
      timezone: 'UTC',
      isActive: false,
    }
    assert.equal(isDue(schedule, null, new Date()), false)
    assert.equal(isDue(schedule, hoursAgo(2), new Date()), false)
  })

  // 3. hourly — never run → due
  it('hourly: returns true when lastExecutedAt is null', () => {
    const schedule: AgentSchedule = {
      type: 'hourly',
      time: '',
      cron: '',
      timezone: 'UTC',
      isActive: true,
    }
    assert.equal(isDue(schedule, null, new Date()), true)
  })

  // 4. hourly — ran 59 min ago → NOT due
  it('hourly: returns false when last ran 59 minutes ago', () => {
    const schedule: AgentSchedule = {
      type: 'hourly',
      time: '',
      cron: '',
      timezone: 'UTC',
      isActive: true,
    }
    assert.equal(isDue(schedule, minutesAgo(59), new Date()), false)
  })

  // 5. hourly — ran 61 min ago → due
  it('hourly: returns true when last ran 61 minutes ago', () => {
    const schedule: AgentSchedule = {
      type: 'hourly',
      time: '',
      cron: '',
      timezone: 'UTC',
      isActive: true,
    }
    assert.equal(isDue(schedule, minutesAgo(61), new Date()), true)
  })

  // 6. daily — before scheduled time today → NOT due
  it('daily: returns false when now is before the scheduled time today', () => {
    // Schedule: runs at 23:59 UTC. now = 08:00 UTC today.
    const now = nowAtTime(8, 0, 'UTC')
    const schedule: AgentSchedule = {
      type: 'daily',
      time: '23:59',
      cron: '',
      timezone: 'UTC',
      isActive: true,
    }
    assert.equal(isDue(schedule, null, now), false)
  })

  // 7. daily — after scheduled time today, never ran → due
  it('daily: returns true when now is past the scheduled time and never ran', () => {
    // Schedule: runs at 00:01 UTC. now = 08:00 UTC.
    const now = nowAtTime(8, 0, 'UTC')
    const schedule: AgentSchedule = {
      type: 'daily',
      time: '00:01',
      cron: '',
      timezone: 'UTC',
      isActive: true,
    }
    assert.equal(isDue(schedule, null, now), true)
  })

  // 8. daily — past scheduled time but already ran today → NOT due
  it('daily: returns false when already ran today after the scheduled time', () => {
    // Schedule: runs at 09:00 UTC. now = 10:00 UTC. Last ran at 09:30 UTC today.
    const now = nowAtTime(10, 0, 'UTC')
    const scheduledToday = nowAtTime(9, 0, 'UTC')
    // last ran 30 min after the scheduled instant (so after it)
    const lastRan = new Date(scheduledToday.getTime() + 30 * 60 * 1000)
    const schedule: AgentSchedule = {
      type: 'daily',
      time: '09:00',
      cron: '',
      timezone: 'UTC',
      isActive: true,
    }
    assert.equal(isDue(schedule, lastRan, now), false)
  })

  // 9. weekly — never ran, after scheduled time → due
  it('weekly: returns true when never ran and now is past the scheduled time', () => {
    const now = nowAtTime(10, 0, 'UTC')
    const schedule: AgentSchedule = {
      type: 'weekly',
      time: '09:00',
      cron: '',
      timezone: 'UTC',
      isActive: true,
    }
    assert.equal(isDue(schedule, null, now), true)
  })

  // 10. weekly — ran 6 days ago → NOT due (need 7)
  it('weekly: returns false when last ran 6 days ago', () => {
    const now = nowAtTime(10, 0, 'UTC')
    const schedule: AgentSchedule = {
      type: 'weekly',
      time: '09:00',
      cron: '',
      timezone: 'UTC',
      isActive: true,
    }
    assert.equal(isDue(schedule, daysAgo(6), now), false)
  })

  // 11. weekly — ran 8 days ago → due
  it('weekly: returns true when last ran 8 days ago', () => {
    const now = nowAtTime(10, 0, 'UTC')
    const schedule: AgentSchedule = {
      type: 'weekly',
      time: '09:00',
      cron: '',
      timezone: 'UTC',
      isActive: true,
    }
    assert.equal(isDue(schedule, daysAgo(8), now), true)
  })

  // 12. cron — minimal matcher: "*/15 * * * *" matches a time that is on the quarter hour
  it('cron: returns true when now matches the cron expression', () => {
    // Use a time that is on the :00 minute boundary — will match "*/15 * * * *"
    const base = nowAtTime(12, 0, 'UTC')
    // set seconds/ms to 0
    const now = new Date(base)
    now.setUTCSeconds(0, 0)
    // verify it's on a 15-min boundary
    const minUTC = now.getUTCMinutes()
    const adjustedMin = Math.floor(minUTC / 15) * 15
    now.setUTCMinutes(adjustedMin, 0, 0)

    const schedule: AgentSchedule = {
      type: 'cron',
      time: '',
      cron: '*/15 * * * *',
      timezone: 'UTC',
      isActive: true,
    }
    assert.equal(isDue(schedule, null, now), true)
  })

  // 13. cron — no matching minute in the catch-up window → NOT due
  it('cron: returns false when no cron-matching minute is in the window', () => {
    // "0 3 * * *" = 03:00 every day. now = 10:00, last ran at 04:00 today
    // (after the 03:00 fire) so no matching minute exists in (04:00, 10:00].
    const now = nowAtTime(10, 0, 'UTC')
    const lastExecutedAt = nowAtTime(4, 0, 'UTC')
    const schedule: AgentSchedule = {
      type: 'cron',
      time: '',
      cron: '0 3 * * *',
      timezone: 'UTC',
      isActive: true,
    }
    assert.equal(isDue(schedule, lastExecutedAt, now), false)
  })

  // 14. cron catch-up — "0 9 * * *" with lastExecutedAt = yesterday and
  //     now = today 13:00 should return true (the 09:00 minute is in the
  //     (since, now] window even though now itself is not 09:00).
  it('cron: catches up when a matching minute is in the window since last run', () => {
    const now = nowAtTime(13, 0, 'UTC')
    const lastExecutedAt = daysAgo(1)
    const schedule: AgentSchedule = {
      type: 'cron',
      time: '',
      cron: '0 9 * * *',
      timezone: 'UTC',
      isActive: true,
    }
    assert.equal(isDue(schedule, lastExecutedAt, now), true)
  })

  // 15. cron catch-up — same "0 9 * * *" cron, but lastExecutedAt = today 10:00
  //     (after the 09:00 fire). No matching minute exists in (10:00, 13:00],
  //     so it should return false.
  it('cron: does not re-fire when last run was after the scheduled minute', () => {
    const now = nowAtTime(13, 0, 'UTC')
    const lastExecutedAt = nowAtTime(10, 0, 'UTC')
    const schedule: AgentSchedule = {
      type: 'cron',
      time: '',
      cron: '0 9 * * *',
      timezone: 'UTC',
      isActive: true,
    }
    assert.equal(isDue(schedule, lastExecutedAt, now), false)
  })
})

describe('isDue — once (one-time)', () => {
  const past = (): AgentSchedule => ({ type: 'once', time: '09:00', cron: '', timezone: 'UTC', runAt: '2020-01-01', isActive: true })

  it('fires when the target instant has passed and it never ran', () => {
    assert.equal(isDue(past(), null, new Date()), true)
  })

  it('does not fire again once it has run', () => {
    assert.equal(isDue(past(), daysAgo(1), new Date()), false)
  })

  it('does not fire before its target instant', () => {
    const schedule: AgentSchedule = { type: 'once', time: '09:00', cron: '', timezone: 'UTC', runAt: '2999-01-01', isActive: true }
    assert.equal(isDue(schedule, null, new Date()), false)
  })

  it('does not fire when inactive', () => {
    assert.equal(isDue({ ...past(), isActive: false }, null, new Date()), false)
  })

  it('does not fire when runAt is missing', () => {
    assert.equal(isDue({ type: 'once', time: '09:00', cron: '', timezone: 'UTC', isActive: true }, null, new Date()), false)
  })

  it('respects the target time on the target day', () => {
    // Target 09:00 UTC today; at 08:00 UTC it is not due, at 10:00 UTC it is.
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    const schedule: AgentSchedule = { type: 'once', time: '09:00', cron: '', timezone: 'UTC', runAt: parts, isActive: true }
    assert.equal(isDue(schedule, null, nowAtTime(8, 0, 'UTC')), false)
    assert.equal(isDue(schedule, null, nowAtTime(10, 0, 'UTC')), true)
  })
})

// --- nextOccurrence ----------------------------------------------------------

test('nextOccurrence: daily returns today’s instant when still ahead, else tomorrow’s', () => {
  const schedule = { type: 'daily', time: '09:00', cron: '', timezone: 'UTC', isActive: true } as AgentSchedule
  const before = nextOccurrence(schedule, new Date('2026-07-09T05:00:00Z'))
  assert.equal(before?.toISOString(), '2026-07-09T09:00:00.000Z')
  const after = nextOccurrence(schedule, new Date('2026-07-09T10:00:00Z'))
  assert.equal(after?.toISOString(), '2026-07-10T09:00:00.000Z')
})

test('nextOccurrence: respects timezone wall-clock', () => {
  const schedule = { type: 'daily', time: '09:00', cron: '', timezone: 'America/New_York', isActive: true } as AgentSchedule
  const next = nextOccurrence(schedule, new Date('2026-07-09T05:00:00Z')) // 01:00 NY
  assert.equal(next?.toISOString(), '2026-07-09T13:00:00.000Z') // 09:00 EDT = 13:00Z
})

test('nextOccurrence: once in the future fires once, in the past returns null', () => {
  const future = { type: 'once', time: '12:00', cron: '', timezone: 'UTC', runAt: '2026-07-10', isActive: true } as AgentSchedule
  assert.equal(nextOccurrence(future, new Date('2026-07-09T00:00:00Z'))?.toISOString(), '2026-07-10T12:00:00.000Z')
  assert.equal(nextOccurrence(future, new Date('2026-07-11T00:00:00Z')), null)
})

test('nextOccurrence: cron scans forward with the existing matcher', () => {
  const schedule = { type: 'cron', time: '', cron: '30 14 * * 1', timezone: 'UTC', isActive: true } as AgentSchedule
  const next = nextOccurrence(schedule, new Date('2026-07-09T00:00:00Z')) // Thursday
  assert.equal(next?.toISOString(), '2026-07-13T14:30:00.000Z') // next Monday 14:30
})

test('nextOccurrence: manual and inactive return null', () => {
  assert.equal(nextOccurrence({ type: 'manual', time: '', cron: '', timezone: 'UTC', isActive: true } as AgentSchedule, new Date()), null)
  assert.equal(nextOccurrence({ type: 'daily', time: '09:00', cron: '', timezone: 'UTC', isActive: false } as AgentSchedule, new Date()), null)
})

// isDue's hourly case never reads `time` — it fires when lastExecutedAt is
// null, else 60 real minutes after lastExecutedAt (no clock-alignment to the
// top of the hour). nextOccurrence has no lastExecutedAt input, so it mirrors
// that convention by treating `from` as the anchor: the next occurrence is
// exactly 60 minutes after `from`, preserving `from`'s minute/second rather
// than rounding to :00.
test('nextOccurrence: hourly fires exactly 60 minutes after `from` (not aligned to the top of the hour)', () => {
  const schedule = { type: 'hourly', time: '', cron: '', timezone: 'UTC', isActive: true } as AgentSchedule
  const next = nextOccurrence(schedule, new Date('2026-07-09T05:37:00Z'))
  assert.equal(next?.toISOString(), '2026-07-09T06:37:00.000Z')
})

// isDue's weekly case never reads a day-of-week field (AgentSchedule has
// none) — it only requires >=7 days since lastExecutedAt (or null) AND that
// `now` is past *today's* scheduled time. So the "day of week" it fires on is
// whatever day is >=7 days after the anchor, not a stored weekday.
// nextOccurrence mirrors this using `from` as the 7-day anchor: this week's
// scheduled instant if still ahead, else the same wall-clock time 7 days out.
test('nextOccurrence: weekly returns this week’s instant when still ahead, else 7 days out', () => {
  const schedule = { type: 'weekly', time: '09:00', cron: '', timezone: 'UTC', isActive: true } as AgentSchedule
  const before = nextOccurrence(schedule, new Date('2026-07-09T05:00:00Z'))
  assert.equal(before?.toISOString(), '2026-07-09T09:00:00.000Z')
  const after = nextOccurrence(schedule, new Date('2026-07-09T10:00:00Z'))
  assert.equal(after?.toISOString(), '2026-07-16T09:00:00.000Z')
})

// ---------------------------------------------------------------------------
// Anchored schedules — a just-saved schedule must not fire instantly.
//
// Without an anchor, isDue treats the entire past as missed occurrences: a
// never-run hourly agent is due immediately, a daily agent saved at 15:00 for
// 09:00 fires at save time, and a fresh cron looks back 25 hours. The anchor
// (stamped at save time by anchorSchedule) floors the catch-up window so the
// first run lands on the next real occurrence after the save.
// ---------------------------------------------------------------------------

describe('anchored schedules', () => {
  it('hourly: not due until 60 minutes after the anchor, even when never run', () => {
    const fresh = { type: 'hourly', time: '', cron: '', timezone: 'UTC', isActive: true, anchor: minutesAgo(1).toISOString() } as AgentSchedule
    assert.equal(isDue(fresh, null, new Date()), false)
    const hourOld = { ...fresh, anchor: minutesAgo(61).toISOString() } as AgentSchedule
    assert.equal(isDue(hourOld, null, new Date()), true)
  })

  it('daily: saved after today’s time already passed → waits for tomorrow', () => {
    const now = new Date('2026-08-07T15:00:00Z')
    const schedule = { type: 'daily', time: '09:00', cron: '', timezone: 'UTC', isActive: true, anchor: '2026-08-07T14:00:00Z' } as AgentSchedule
    assert.equal(isDue(schedule, null, now), false)
    // Anchored before today's occurrence → today's 09:00 still fires.
    const savedYesterday = { ...schedule, anchor: '2026-08-06T18:00:00Z' } as AgentSchedule
    assert.equal(isDue(savedYesterday, null, now), true)
    // A run after the anchor still gates the next one as before.
    assert.equal(isDue(savedYesterday, new Date('2026-08-07T09:01:00Z'), now), false)
  })

  it('weekly: a fresh anchor starts the 7-day clock at save time', () => {
    const now = new Date('2026-08-07T15:00:00Z')
    const schedule = { type: 'weekly', time: '09:00', cron: '', timezone: 'UTC', isActive: true, anchor: '2026-08-06T10:00:00Z' } as AgentSchedule
    assert.equal(isDue(schedule, null, now), false)
    const weekOld = { ...schedule, anchor: '2026-07-30T10:00:00Z' } as AgentSchedule
    assert.equal(isDue(weekOld, null, now), true)
  })

  it('cron: owes nothing from before the anchor', () => {
    const now = new Date('2026-08-07T15:00:00Z')
    const schedule = { type: 'cron', time: '', cron: '0 9 * * *', timezone: 'UTC', isActive: true, anchor: '2026-08-07T14:00:00Z' } as AgentSchedule
    assert.equal(isDue(schedule, null, now), false)
    const beforeNine = { ...schedule, anchor: '2026-08-07T08:00:00Z' } as AgentSchedule
    assert.equal(isDue(beforeNine, null, now), true)
  })

  it('once: a target that had already passed when the schedule was saved never fires', () => {
    const now = new Date('2026-08-07T15:00:00Z')
    const stale = { type: 'once', time: '09:00', cron: '', timezone: 'UTC', isActive: true, runAt: '2026-08-07', anchor: '2026-08-07T14:00:00Z' } as AgentSchedule
    assert.equal(isDue(stale, null, now), false)
    assert.equal(nextOccurrence(stale, new Date('2026-08-07T08:00:00Z')), null)
    // Saved before the target → fires once the target passes, as before.
    const ahead = { ...stale, anchor: '2026-08-07T08:00:00Z' } as AgentSchedule
    assert.equal(isDue(ahead, null, now), true)
  })

  it('legacy schedules without an anchor keep catch-up behavior', () => {
    const now = new Date('2026-08-07T15:00:00Z')
    const daily = { type: 'daily', time: '09:00', cron: '', timezone: 'UTC', isActive: true } as AgentSchedule
    assert.equal(isDue(daily, null, now), true)
  })

  it('an invalid anchor string is ignored rather than wedging the schedule', () => {
    const now = new Date('2026-08-07T15:00:00Z')
    const daily = { type: 'daily', time: '09:00', cron: '', timezone: 'UTC', isActive: true, anchor: 'not-a-date' } as AgentSchedule
    assert.equal(isDue(daily, null, now), true)
  })
})

describe('anchorSchedule', () => {
  it('stamps a fresh anchor on a new or changed schedule', () => {
    const next = { type: 'daily', time: '09:00', cron: '', timezone: 'UTC', isActive: true } as AgentSchedule
    const stamped = anchorSchedule(next)
    assert.ok(stamped.anchor && !Number.isNaN(new Date(stamped.anchor).getTime()))
    const changed = anchorSchedule({ ...next, time: '10:00' }, stamped)
    assert.ok(changed.anchor && changed.anchor >= stamped.anchor!)
  })

  it('preserves the previous anchor when scheduling fields are unchanged', () => {
    const prev = { type: 'daily', time: '09:00', cron: '', timezone: 'UTC', isActive: true, anchor: '2026-08-01T00:00:00.000Z' } as AgentSchedule
    const saved = anchorSchedule({ type: 'daily', time: '09:00', cron: '', timezone: 'UTC', isActive: true } as AgentSchedule, prev)
    assert.equal(saved.anchor, '2026-08-01T00:00:00.000Z')
  })

  it('re-stamps when a paused schedule is reactivated', () => {
    const prev = { type: 'daily', time: '09:00', cron: '', timezone: 'UTC', isActive: false, anchor: '2026-08-01T00:00:00.000Z' } as AgentSchedule
    const saved = anchorSchedule({ type: 'daily', time: '09:00', cron: '', timezone: 'UTC', isActive: true } as AgentSchedule, prev)
    assert.notEqual(saved.anchor, '2026-08-01T00:00:00.000Z')
  })
})

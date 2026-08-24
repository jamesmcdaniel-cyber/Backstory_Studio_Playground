/**
 * `nextRunAt`: the scheduler's index key, so a tick reads only the rows that
 * could possibly be due.
 *
 * ── What this replaces ────────────────────────────────────────────────────
 * The tick used to read EVERY active agent and every active flow, on every
 * tick, and evaluate dueness in Node — because dueness lives in a JSON
 * `schedule` column and in cron expressions, neither of which SQL can evaluate.
 * That was the correct fix for the bug before it (an unordered `take: 200` that
 * silently stopped firing anything outside its window), and it is honest at a
 * few hundred rows.
 *
 * It does not survive 1,000 users. The tick runs every 60 seconds; the scan is
 * O(all active rows) with a 20,000-row runaway backstop — and crossing that
 * backstop reintroduces exactly the silent-truncation failure the complete scan
 * existed to eliminate. The table also grows with the product forever, while the
 * number of rows actually DUE in any given minute stays small.
 *
 * So the dueness computation moves to WRITE time, where it happens once per
 * schedule change instead of once per row per minute, and the tick becomes an
 * indexed range read.
 *
 * ── The safety property that makes this shippable ─────────────────────────
 * `nextRunAt` is a PRE-FILTER, never the authority. The tick still calls
 * `isDue()` on every row it reads, exactly as before. So a `nextRunAt` that is
 * too EARLY costs one wasted row read and nothing else.
 *
 * The only dangerous direction is too LATE — a row that skips its window. Every
 * choice below therefore rounds toward "examine it":
 *
 *   NULL              →  always read. This is what an un-backfilled row, or a
 *                        write path that forgot to stamp one, looks like. The
 *                        failure mode of forgetting is extra work, not a
 *                        schedule that silently stops. That asymmetry is the
 *                        whole design.
 *   a real instant    →  read once that instant passes.
 *   NOT_SCHEDULED_AT  →  never read, until something rewrites it.
 *
 * ── Why a sentinel rather than NULL for "not scheduled" ───────────────────
 * NULL cannot mean both "unknown, examine it" and "manual, skip it", and the
 * distinction is not academic: manual agents are the MAJORITY of the table.
 * Folding them into NULL would leave the tick reading nearly every row it reads
 * today, and the index would buy nothing.
 */
import { isDue, nextOccurrence, type AgentSchedule } from '@/lib/scheduling/due'

/**
 * "There is no next occurrence." Far enough out that no real schedule reaches
 * it, and a plain timestamp so the same `nextRunAt <= now` index range serves
 * every case without special-casing NULL in the hot query.
 *
 * Anything wearing this is invisible to the scheduler by design: manual agents,
 * deactivated schedules, and one-time runs that have already fired. It is not a
 * tombstone — every write path recomputes, so re-activating a schedule restores
 * a real instant.
 */
export const NOT_SCHEDULED_AT = new Date('9999-12-31T00:00:00.000Z')

/**
 * An anchor for schedules whose dueness is defined relative to the last run
 * ('hourly', 'weekly') and which have never run.
 *
 * `nextOccurrence` has no execution-history input: it answers "when next, after
 * `from`". Passing `now` for a never-run hourly agent would return now + 60
 * minutes and defer by an hour something `isDue` considers due immediately.
 * Anchoring in the distant past makes the computed instant land in the past
 * too, so the row is read on the next tick and `isDue` gets to make the call —
 * which is the division of labour this whole file depends on.
 */
const NEVER_RUN_ANCHOR = new Date('1970-01-01T00:00:00.000Z')

/**
 * When to next read this row.
 *
 * Returns NOT_SCHEDULED_AT for anything that cannot fire, and never returns
 * null — a caller with nothing to store should leave the column NULL itself, so
 * "I chose not to schedule this" and "I could not compute one" stay
 * distinguishable in the data.
 */
export function computeNextRunAt(
  schedule: unknown,
  lastExecutedAt: Date | null | undefined,
  now: Date = new Date(),
): Date {
  if (!schedule || typeof schedule !== 'object') return NOT_SCHEDULED_AT
  const parsed = schedule as AgentSchedule
  if (!parsed.isActive || parsed.type === 'manual') return NOT_SCHEDULED_AT

  // Already due right now — do not let a forward-looking computation push a row
  // that should fire this minute into the future. This is the case that would
  // otherwise skip a window, so it is checked before anything else.
  if (isDue(parsed, lastExecutedAt ?? null, now)) return now

  const anchor = lastExecutedAt ?? NEVER_RUN_ANCHOR
  const next = nextOccurrence(parsed, anchor)
  if (!next) return NOT_SCHEDULED_AT

  // A computed instant already in the past means the anchor was stale (the row
  // missed ticks while paused, or the process was down). Reading it on the next
  // tick and letting isDue decide is both correct and cheap; inventing a future
  // instant here would suppress a run that is legitimately overdue.
  return next
}

/** True when a stored value means "the scheduler should ignore this row". */
export function isNotScheduled(nextRunAt: Date | null | undefined): boolean {
  return nextRunAt !== null && nextRunAt !== undefined && nextRunAt.getTime() === NOT_SCHEDULED_AT.getTime()
}

/**
 * Fields whose change can move a row's next due instant.
 *
 * Note what is NOT here: creating a `FlowRun`. A flow's "last run" marker is its
 * most recent run, so a manually- or webhook-triggered run does change dueness —
 * but only ever by making the stored `nextRunAt` EARLIER than the truth. The row
 * is then read a little sooner than needed, `isDue` says no, and the tick
 * restamps it. Self-correcting in the safe direction, so it needs no hook.
 */
const RECOMPUTE_TRIGGERS: Record<string, string[]> = {
  AgentTask: ['schedule', 'lastExecutedAt', 'status', 'quarantinedAt'],
  Flow: ['trigger', 'status', 'publishedGraph', 'pollCursor', 'quarantinedAt'],
}

const WRITE_OPERATIONS = new Set([
  'create', 'createMany', 'createManyAndReturn',
  'update', 'updateMany', 'updateManyAndReturn', 'upsert',
])

function markOne(data: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  // An explicit nextRunAt in the write wins. That is how the tick stamps a row
  // it has just evaluated — and clobbering it to NULL here would put every
  // examined row straight back into the next tick's read set, so the scan would
  // never shrink and this whole mechanism would quietly do nothing.
  if ('nextRunAt' in data) return data
  if (!fields.some((field) => field in data)) return data
  return { ...data, nextRunAt: null }
}

/**
 * Force `nextRunAt` to NULL — "recompute me" — on any write that could change
 * when a row is next due.
 *
 * Applied at the Prisma chokepoint rather than at call sites, and the reason is
 * the failure mode. A route that edits a schedule and forgets to restamp would
 * leave the OLD instant in place, which can sit in the future and silently skip
 * the new schedule — the exact class of bug ("the schedule just doesn't work for
 * that customer") this column was added to eliminate. Nulling instead of
 * recomputing keeps this hook cheap and total: it needs no knowledge of the
 * row's other fields, so it works for `updateMany` and partial writes alike, and
 * the tick does the real computation where the whole row is in hand.
 */
export function applyScheduleRecompute(model: string | undefined, operation: string, args: unknown): unknown {
  if (!model || !WRITE_OPERATIONS.has(operation)) return args
  const fields = RECOMPUTE_TRIGGERS[model]
  if (!fields) return args
  const typed = args as { data?: unknown; create?: unknown; update?: unknown }
  if (!typed || typeof typed !== 'object') return args

  // `changed` exists so the common case — the overwhelming majority of writes,
  // which touch none of these fields — returns the caller's own object
  // untouched. This runs on EVERY Prisma write in the process; allocating a
  // shallow copy of every args object to usually change nothing is a cost worth
  // not paying.
  let changed = false
  const mapValue = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map((entry) => {
        if (!entry || typeof entry !== 'object') return entry
        const marked = markOne(entry as Record<string, unknown>, fields)
        if (marked !== entry) changed = true
        return marked
      })
    }
    if (value && typeof value === 'object') {
      const marked = markOne(value as Record<string, unknown>, fields)
      if (marked !== value) changed = true
      return marked
    }
    return value
  }

  const next: Record<string, unknown> = { ...(typed as Record<string, unknown>) }
  if ('data' in typed) next.data = mapValue(typed.data)
  // upsert carries two payloads and both can change the schedule.
  if ('create' in typed) next.create = mapValue(typed.create)
  if ('update' in typed) next.update = mapValue(typed.update)
  return changed ? next : args
}

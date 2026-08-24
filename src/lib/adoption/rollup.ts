/**
 * Pure adoption maths.
 *
 * Every load-bearing decision in the adoption rollups lives here, deliberately
 * free of Prisma and of I/O, so week boundaries and cohort assembly can be
 * tested exhaustively without a database — the same split as
 * src/lib/agents/roster.ts.
 *
 * Weeks are ISO weeks starting Monday, in UTC. All four source columns
 * (AgentTask.createdAt, AgentExecution.startedAt, AgentChatMessage.createdAt,
 * ApprovalRequest.createdAt) are Prisma-default naive timestamps holding UTC.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

/** Monday 00:00:00.000 UTC of the ISO week containing `date`. */
export function weekStartUtc(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const dow = d.getUTCDay() // 0 = Sunday
  // Monday-based: Sunday is the SEVENTH day of its week, not the first.
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1))
  return d
}

export function addWeeks(week: Date, n: number): Date {
  return new Date(week.getTime() + n * WEEK_MS)
}

/** `YYYY-MM-DD`, the canonical key for a week everywhere in this module. */
export function weekKey(week: Date): string {
  return week.toISOString().slice(0, 10)
}

/**
 * The `count` most recent COMPLETE weeks, oldest first. The week containing
 * `now` is excluded: a partial week always renders as a dip, and a dip on an
 * adoption chart gets read as decay.
 */
export function completeWeeksBack(now: Date, count: number): Date[] {
  const current = weekStartUtc(now)
  const weeks: Date[] = []
  for (let i = count; i >= 1; i--) weeks.push(addWeeks(current, -i))
  return weeks
}

/** Whole weeks from `cohortWeek` to `activeWeek`. Both are `YYYY-MM-DD` keys. */
export function weekOffset(cohortWeek: string, activeWeek: string): number {
  const from = Date.parse(`${cohortWeek}T00:00:00Z`)
  const to = Date.parse(`${activeWeek}T00:00:00Z`)
  return Math.round((to - from) / WEEK_MS)
}

/**
 * A rate, or null when there is nothing to rate. Never 0 for an empty
 * denominator — "no runs at all" and "every run was manual" are opposite
 * findings and must not render identically.
 */
export function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null
  return numerator / denominator
}

export function automationRatio(execTotal: number, execManual: number): number | null {
  return ratio(execTotal - execManual, execTotal)
}

export function acceptanceRate(approved: number, rejected: number): number | null {
  return ratio(approved, approved + rejected)
}

export interface CohortRow {
  agentTaskId: string
  cohortWeek: string
  activeWeek: string
}

export interface SurvivalCell {
  offset: number
  active: number
  /** active / size. 0 for an empty cohort — never NaN. */
  rate: number
}

export interface SurvivalRow {
  cohortWeek: string
  size: number
  cells: SurvivalCell[]
}

/**
 * The retention matrix.
 *
 * `cohortSizes` is every agent CREATED in a week, including agents that never
 * ran once. Those stay in the denominator and score 0 in every cell — that is
 * the "created it, never touched it again" case, and it is the single most
 * important thing this curve exists to catch.
 *
 * Counting rows directly is safe: agent_cohort_weeks is unique on
 * (agentTaskId, activeWeek), and cohortWeek is functionally determined by the
 * agent, so one agent can contribute at most one row per (cohort, offset).
 */
export function buildSurvival(
  cohortSizes: Map<string, number>,
  rows: CohortRow[],
  maxOffset: number,
): SurvivalRow[] {
  const counts = new Map<string, number>() // `${cohortWeek}|${offset}` -> active
  for (const row of rows) {
    const offset = weekOffset(row.cohortWeek, row.activeWeek)
    // An agent cannot run before it exists, and anything past the reported
    // horizon is not part of this matrix.
    if (offset < 0 || offset > maxOffset) continue
    const key = `${row.cohortWeek}|${offset}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  return [...cohortSizes.keys()]
    .sort()
    .map((cohortWeek) => {
      const size = cohortSizes.get(cohortWeek) ?? 0
      const cells: SurvivalCell[] = []
      for (let offset = 0; offset <= maxOffset; offset++) {
        const active = counts.get(`${cohortWeek}|${offset}`) ?? 0
        cells.push({ offset, active, rate: size > 0 ? active / size : 0 })
      }
      return { cohortWeek, size, cells }
    })
}

/**
 * Engaged-user buckets. The 1-vs-many split is the whole point: an org where
 * one person runs everything is a pilot, not an adoption.
 */
export function depthBucket(users: number): string {
  if (users <= 0) return '0'
  if (users === 1) return '1'
  if (users <= 4) return '2-4'
  if (users <= 9) return '5-9'
  return '10+'
}

/**
 * Complete, paginated scan of a scheduling candidate table.
 *
 * The scheduler used to read `findMany({ where: { status: 'ACTIVE' }, take: 200 })`
 * with no ordering and no cursor. Past 200 active agents platform-wide, Postgres
 * returned an arbitrary — and in practice stable — subset, so the agents outside
 * that window were never even EXAMINED for dueness. They stopped firing, for
 * good, and nothing logged it. It is the kind of failure that looks like "the
 * schedule just doesn't work for that customer".
 *
 * Two separate limits fix that, and it matters that they are separate:
 *
 *   - the SCAN is complete: every active row is read and evaluated every tick,
 *     paginated by id cursor. Dueness lives in a JSON `schedule` column and in
 *     cron expressions, so it cannot be pushed into SQL — which means the only
 *     way to be sure a due row is noticed is to look at all of them.
 *   - the DISPATCH is capped, and the cap is applied to rows already SORTED by
 *     staleness. Overflow is deferred to the next tick rather than dropped, and
 *     because dispatching updates the row's last-run marker, a deferred row
 *     sorts ahead of the ones that just ran. That is what makes it fair instead
 *     of merely bounded.
 *
 * `maxRows` is a runaway backstop, not a capacity limit: hitting it means
 * something is wrong (a table far larger than the product should produce), so
 * it reports `truncated` for the caller to log loudly.
 */

export interface ScanResult<T> {
  rows: T[]
  /** True when the backstop stopped the scan early — some rows were NOT examined. */
  truncated: boolean
}

export const DEFAULT_SCAN_PAGE_SIZE = 500
export const DEFAULT_SCAN_MAX_ROWS = 20_000

/**
 * Read every row `page` yields, following an id cursor until a short page ends
 * the scan. `page` must order by id ascending and return at most `take` rows.
 */
export async function scanAll<T extends { id: string }>(
  page: (cursorId: string | null, take: number) => Promise<T[]>,
  options: { pageSize?: number; maxRows?: number } = {},
): Promise<ScanResult<T>> {
  const pageSize = Math.max(1, options.pageSize ?? DEFAULT_SCAN_PAGE_SIZE)
  const maxRows = Math.max(pageSize, options.maxRows ?? DEFAULT_SCAN_MAX_ROWS)

  const rows: T[] = []
  let cursor: string | null = null

  for (;;) {
    const batch: T[] = await page(cursor, pageSize)
    rows.push(...batch)

    // A short page means we reached the end — the common case, and the only
    // one that ends the scan without truncation.
    if (batch.length < pageSize) return { rows, truncated: false }
    if (rows.length >= maxRows) return { rows, truncated: true }
    cursor = batch[batch.length - 1].id
  }
}

/**
 * Order scheduling candidates stalest-first, so a cap on dispatch takes the rows
 * that have been waiting longest. `null` (never run) sorts first — a brand-new
 * schedule must not queue behind everything that has already had a turn.
 */
export function stalestFirst<T>(rows: T[], lastRunAt: (row: T) => Date | null | undefined): T[] {
  return [...rows].sort((a, b) => {
    const left = lastRunAt(a)?.getTime()
    const right = lastRunAt(b)?.getTime()
    if (left === undefined || Number.isNaN(left)) return right === undefined || Number.isNaN(right) ? 0 : -1
    if (right === undefined || Number.isNaN(right)) return 1
    return left - right
  })
}

/**
 * The advisory lock the cross-org spend aggregates read under.
 *
 * /api/admin/costs and /api/admin/models both sum the LlmCall table with no
 * organizationId filter — that is the point of them — and their suites prove
 * the sums are right by reading a total twice and asserting how much it moved.
 * On the shared bs_ci_repro database those two reads are not alone: every
 * sibling suite that records or clears LLM usage is writing to the same table
 * at the same time, and a single row appearing or vanishing between the two
 * reads shifts the total by exactly as much as the bug those assertions exist
 * to catch would.
 *
 * The rule the key encodes is therefore narrow and absolute: while a suite
 * holds this lock, the set of LlmCall rows in the window does not change.
 * Writers cannot know when a reader is mid-assertion, so they take the lock
 * unconditionally; it is uncontended in the common case and costs a statement.
 *
 * Creates matter as much as deletes. A row that exists across BOTH reads is
 * harmless — it lands in each total identically and cancels out — so what has
 * to be excluded is the transition, in either direction.
 */
export const USAGE_AGGREGATE_LOCK = 918273645

const LOCK_SQL = `SELECT pg_advisory_xact_lock(${USAGE_AGGREGATE_LOCK})`
const LOCK_OPTS = { timeout: 30_000, maxWait: 30_000 }

/**
 * Run `write` with the aggregate readers held off.
 *
 * `write` deliberately receives nothing: callers use their ordinary outer
 * client inside it, so each statement commits as it runs and is visible to a
 * route handler reading on its own pooled connection. Handing back the
 * transaction client instead would hide the rows from exactly the code most of
 * these suites go on to call.
 */
export async function withUsageAggregateLock<T>(
  prisma: { $transaction: (fn: (tx: unknown) => Promise<T>, opts?: unknown) => Promise<T> },
  write: () => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx: unknown) => {
    await (tx as { $executeRawUnsafe: (sql: string) => Promise<unknown> }).$executeRawUnsafe(LOCK_SQL)
    return write()
  }, LOCK_OPTS)
}

/**
 * recordLlmCall's client seam, wired to take the lock.
 *
 * The ledger writes its detail row and its rollup bumps in one transaction it
 * opens itself, so there is no outer transaction to hang a lock on — but the
 * client is injectable precisely so a test can decide what `$transaction`
 * means. Taking the lock as that transaction's first statement puts the ledger's
 * own write inside the critical section without changing what it writes.
 *
 * Hand it `systemPrisma`, not the guarded client. recordLlmCall defaults to the
 * system client in production, and the guarded one opens transactions under a
 * single tenant — which silently drops rows written for any other org, and
 * recordLlmCall swallows the failure by contract, so the loss surfaces as a
 * later assertion finding nothing rather than as an error here.
 */
export function lockedLedgerClient(prisma: {
  $transaction: (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) => Promise<unknown>
}) {
  return {
    $transaction: <T>(fn: (tx: never) => Promise<T>): Promise<T> =>
      prisma.$transaction(async (tx: unknown) => {
        await (tx as { $executeRawUnsafe: (sql: string) => Promise<unknown> }).$executeRawUnsafe(LOCK_SQL)
        return fn(tx as never)
      }, LOCK_OPTS) as Promise<T>,
  }
}

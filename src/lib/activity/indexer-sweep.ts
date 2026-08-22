/**
 * Activity → graph-RAG indexer sweep.
 *
 * `ActivityEvent.indexedAt` is the sole authority on "has this event reached
 * the graph" — nullable, indexed by `[organizationId, indexedAt]` (Task 1).
 * This sweep is the only writer of that column: it batches `indexedAt IS
 * NULL` rows (200 at a time, oldest first), builds graph nodes/edges via
 * `commitActivity`, and stamps `indexedAt` ONLY for the ids that batch
 * reports as committed. A row is never stamped speculatively — if
 * `ragEnabled()` is false (no VOYAGE_API_KEY / Neo4j configured), or a
 * particular org's commit throws, those rows stay `indexedAt: null` and are
 * picked up again on the next tick. That makes the sweep idempotent
 * (re-running an already-stamped batch selects nothing) and safe against a
 * permanently-failing batch (no internal retry loop here — each cron
 * invocation is exactly one pass; a stuck row is retried at cron cadence,
 * not spun on in-process).
 *
 * Dispatched claims for each event are read alongside it so `commitActivity`
 * can wire `activity_triggered_run`/`about_activity` edges to the run(s) the
 * event fired — see `src/lib/rag/indexer.ts`.
 */

import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { commitActivity, type ActivityIndexInput, type CommitOptions } from '@/lib/rag/indexer'
import { ragEnabled } from '@/lib/rag/get-store'

export const INDEXER_SWEEP_BATCH_SIZE = 200

export interface IndexerSweepResult {
  scanned: number
  indexed: number
  /** True when the pass was skipped entirely because ragEnabled() is false. */
  skipped: boolean
}

/**
 * `options` forwards `commitActivity`'s test seam (inject a `store` +
 * `fetchImpl` to exercise the real commit-then-stamp path against
 * `MemoryGraphStore` in a DB test without VOYAGE_API_KEY/NEO4J_* configured).
 * Production callers (the cron route) call this with no arguments — the gate
 * below is the real `ragEnabled()` check unless a test explicitly overrides
 * it by passing `store`.
 */
export async function runIndexerSweep(options: CommitOptions = {}): Promise<IndexerSweepResult> {
  if (!options.store && !ragEnabled()) {
    // Never touch indexedAt — the column must never claim rows were indexed
    // while RAG is disabled.
    return { scanned: 0, indexed: 0, skipped: true }
  }

  // systemPrisma: cross-org sweep by design (cron job, not a request context).
  const rows = await systemPrisma.activityEvent.findMany({
    where: { indexedAt: null },
    orderBy: { createdAt: 'asc' },
    take: INDEXER_SWEEP_BATCH_SIZE,
  })
  if (rows.length === 0) return { scanned: 0, indexed: 0, skipped: false }

  // Dispatched (fired) claims for this batch's events, to wire activity→run edges.
  const claims = await systemPrisma.activityTriggerClaim.findMany({
    where: { activityEventId: { in: rows.map((r) => r.id) }, status: 'dispatched', flowRunId: { not: null } },
    select: { activityEventId: true, flowRunId: true },
  })
  const runIdsByEvent = new Map<string, string[]>()
  for (const claim of claims) {
    if (!claim.flowRunId) continue
    const list = runIdsByEvent.get(claim.activityEventId) ?? []
    list.push(claim.flowRunId)
    runIdsByEvent.set(claim.activityEventId, list)
  }

  const inputs: ActivityIndexInput[] = rows.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    source: row.source,
    kind: row.kind,
    subject: row.subject,
    visibility: row.visibility,
    ownerUserId: row.ownerUserId,
    dispatchedRunIds: runIdsByEvent.get(row.id),
  }))

  let committedIds: string[] = []
  try {
    ;({ committedIds } = await commitActivity(inputs, options))
  } catch (error) {
    apiLogger.error('activity/indexer-sweep: commitActivity failed', { error: error instanceof Error ? error.message : String(error) })
    return { scanned: rows.length, indexed: 0, skipped: false }
  }

  if (committedIds.length > 0) {
    // systemPrisma: stamping the authority column for the exact ids that
    // just committed — never a broader/optimistic range.
    await systemPrisma.activityEvent.updateMany({
      where: { id: { in: committedIds } },
      data: { indexedAt: new Date() },
    })
  }

  return { scanned: rows.length, indexed: committedIds.length, skipped: false }
}

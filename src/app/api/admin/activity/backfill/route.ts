import { z } from 'zod'
import { createQueue, getRedisConnection, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'
import { inlineExecution } from '@/lib/queue/execution-mode'
import { runActivityBackfill } from '@/lib/activity/backfill'
import { recordAudit } from '@/lib/audit'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

/**
 * "Backfill" — an internal operator trigger for Task 7's cursor-checkpointed
 * activity backfill (src/lib/activity/backfill.ts). Mirrors
 * /api/admin/models/bench/route.ts's shape: long-running provider I/O runs on
 * the worker in queue mode, detached inline in dev, and a second trigger for
 * the same target while one is already in flight answers `alreadyRunning`
 * rather than stacking a duplicate walk of the same history.
 *
 * `organizationId` is caller-supplied, not `auth.organizationId` — this is a
 * cross-tenant platform-administer surface (same posture as
 * /api/admin/domains), not a self-service org action.
 */

const bodySchema = z.object({
  organizationId: z.string().uuid(),
  source: z.string().min(1).max(50),
  connectionId: z.string().min(1).max(200),
})

function inFlightKey(organizationId: string, source: string, connectionId: string): string {
  return `${organizationId}:${source}:${connectionId}`
}

/**
 * True when a backfill job for this EXACT target (org+source+connection) is
 * waiting, active, or delayed. Unlike bench's in-flight check (one global
 * bench, so counting the whole queue is enough), different backfill targets
 * legitimately run concurrently — an operator re-triggering the same
 * connection's history is what must be prevented, not the queue as a whole.
 * Job ids are timestamped (never reused, same as bench), so this can't rely
 * on jobId collision — it inspects each pending job's own payload instead.
 * `getJobs` here is bounded by BullMQ's own default page size, which is far
 * larger than this queue could plausibly have pending at once for an
 * internal-only, human-triggered admin action.
 */
async function queuedBackfillInFlight(organizationId: string, source: string, connectionId: string): Promise<boolean> {
  const queue = createQueue(QUEUE_NAMES.ACTIVITY_BACKFILL)
  const jobs = await queue.getJobs(['waiting', 'active', 'delayed'])
  return jobs.some(
    (job) => job.data?.organizationId === organizationId && job.data?.source === source && job.data?.connectionId === connectionId,
  )
}

// Serializes inline (dev) runs the same way queuedBackfillInFlight serializes
// queued ones — one in-flight run per target, tracked by the same key so a
// stray promise from an earlier run can't wedge this permanently (cleared in
// the `finally` below regardless of success/failure).
const inlineBackfillsRunning = new Set<string>()

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { organizationId, source, connectionId } = bodySchema.parse(await request.json())
  const inFlightKeyValue = inFlightKey(organizationId, source, connectionId)

  await recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.userId,
    action: 'platform.activity.backfill_started',
    resourceType: 'activity_source_cursor',
    detail: { targetOrganizationId: organizationId, source, connectionId, mode: inlineExecution ? 'inline' : 'queue' },
  })

  if (inlineExecution) {
    if (inlineBackfillsRunning.has(inFlightKeyValue)) return { success: true, alreadyRunning: true }
    inlineBackfillsRunning.add(inFlightKeyValue)
    // Detached: this is the long-lived dev process (never serverless), same
    // reasoning as the bench route's inline branch.
    void runActivityBackfill(organizationId, source, connectionId)
      .catch((error) => console.error('inline activity backfill failed:', error instanceof Error ? error.message : error))
      .finally(() => {
        inlineBackfillsRunning.delete(inFlightKeyValue)
      })
    return { success: true, queued: true, mode: 'inline' }
  }

  if (!workersEnabled) throw new ApiError('The worker runtime is disabled', 503, 'WORKER_DISABLED')
  try {
    await getRedisConnection().connect().catch(() => undefined)
    if (await queuedBackfillInFlight(organizationId, source, connectionId)) return { success: true, alreadyRunning: true }
    const queue = createQueue(QUEUE_NAMES.ACTIVITY_BACKFILL)
    // Timestamped id, like bench: BullMQ never reuses a completed job's id, so
    // a fixed per-target id would allow exactly one backfill EVER for that
    // target. Serialization comes from queuedBackfillInFlight's payload scan
    // above, not from id collision.
    //
    // attempts: 1 — a page's own persist-then-checkpoint ordering already
    // makes re-triggering safe (it just resumes from the last-advanced
    // cursor), so a BullMQ-level automatic retry adds nothing a fresh operator
    // click wouldn't: same reasoning MODEL_BENCH's attempts: 1 documents.
    await queue.add(
      'activity-backfill',
      { organizationId, source, connectionId },
      { jobId: `activity-backfill-${inFlightKeyValue}-${Date.now()}`, attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
    )
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError('Unable to queue the backfill run', 503, 'QUEUE_UNAVAILABLE', error)
  }
  return { success: true, queued: true, mode: 'queue' }
}, { permission: 'platform.administer', internalOnly: true })

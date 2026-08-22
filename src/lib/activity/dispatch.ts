/**
 * The activity-event substrate's matcher + exactly-once dispatcher (Task 6 of
 * docs/superpowers/specs/2026-08-21-activity-event-substrate-design.md).
 *
 * Every receiver (Slack Events API today, Nango forward/sync in Task 3)
 * persists an `ActivityEvent` row and hands its id off through the durable
 * outbox (`activity.dispatch` topic — see src/lib/outbox.ts). This module is
 * the ONLY place that turns a persisted event into flow runs: no webhook
 * handler matches inline (the 3-second Slack budget, and any provider's own
 * budget, has no room for a flow scan), and matching only ever happens once
 * the event already durably exists.
 *
 * Style mirrors `emitFlowSignal` (src/features/flows/signals.ts) closely —
 * same per-flow try/catch isolation, same owner-attribution ladder, same
 * "trigger-level filter before any DB writes" order — because that function
 * is the existing precedent for "one persisted thing fans out to N flow
 * runs, isolated per flow."
 */

import { Prisma } from '@prisma/client'
import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { triggerConditionPasses } from '@/lib/flows/trigger-condition'
import { flowInputFromWebhookBody } from '@/lib/flows/input'
import { dispatchFlowExecution } from '@/features/flows/execute-flow'

/**
 * Loop guard (ruling 2 of the design doc): an event-chain depth cap analogous
 * to `SIGNAL_DEPTH_CAP` (src/features/flows/signals.ts). A flow run started
 * from an activity event carries `chainDepth: event.chainDepth + 1` on its own
 * trigger; if that run's own actions post back into a connected app (a Slack
 * reply, a CRM update) and the receiver stamps a NEW `ActivityEvent` for it,
 * that new event's `chainDepth` is carried forward from the run, not reset to
 * 0. Once a chain reaches this depth, the event is dropped before it even
 * matches a flow.
 */
export const ACTIVITY_CHAIN_DEPTH_CAP = 3

/**
 * Rolling per-flow throttle (ruling 1): how many claims (of ANY status) a
 * single flow may accumulate in a trailing hour before further matches for it
 * are throttled instead of run. Env-overridable for load-testing/ops, same
 * pattern as `orgMaxInFlightRuns` (src/lib/queue/org-capacity.ts).
 */
export function activityRunsPerFlowPerHour(): number {
  const raw = Number(process.env.ACTIVITY_RUNS_PER_FLOW_PER_HOUR)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60
}

// Bound how many ACTIVE matching flows are scanned per event, same
// reasoning/shape as emitFlowSignal's MAX_FLOWS_PER_EMIT.
const MAX_FLOWS_PER_EVENT = 200

// A 'claimed' row this old, with no dispatched/failed row to show for it, is
// not "in flight" — a crash between claim-create and run-dispatch left it
// stranded. Never auto-recovered (that would mean risking a double-fire,
// which is the one thing exactly-once dispatch promises not to do); this is
// purely an observability threshold so a stranded claim is diagnosable
// instead of silently invisible. Matches the outbox's own stale-lock window
// (CLAIM_TIMEOUT_MS in src/lib/outbox.ts) — both are "how long is a claim
// allowed to look in-flight before it's worth a human looking at instead."
const STALE_CLAIM_MS = 10 * 60_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

type ActivityFlowTrigger = {
  type?: unknown
  source?: unknown
  kinds?: unknown
  filters?: { channelId?: unknown; actorExternalId?: unknown }
  channelId?: unknown
  threadOnly?: unknown
  condition?: unknown
}

/**
 * Per-event filter predicate: the config-level narrowing an 'activity' or
 * 'slack' trigger declares BEYOND the source+kind match the indexed query
 * already did. Applied in memory (not SQL) because it reads the event's
 * `subject` blob, which is per-provider shaped and not worth indexing.
 */
function matchesEventFilters(trigger: ActivityFlowTrigger, subject: Record<string, unknown>): boolean {
  if (trigger.type === 'slack') {
    if (typeof trigger.channelId === 'string' && trigger.channelId.trim()) {
      if (subject.channelId !== trigger.channelId) return false
    }
    if (trigger.threadOnly === true && !subject.threadTs) return false
    return true
  }
  if (trigger.type === 'activity') {
    const filters = isRecord(trigger.filters) ? trigger.filters : {}
    if (typeof filters.channelId === 'string' && filters.channelId.trim()) {
      if (subject.channelId !== filters.channelId) return false
    }
    // actorExternalId is compared against the EVENT's actor, not subject —
    // handled by the caller, which has the event row (subject alone doesn't
    // carry it). See matchesActivityEvent below.
    return true
  }
  return true
}

/** Result of one dispatch attempt for a single matched flow — for tests and
 *  for the aggregate summary a caller may want to log. */
export type FlowDispatchOutcome =
  | { flowId: string; outcome: 'dispatched'; flowRunId: string | null }
  | { flowId: string; outcome: 'throttled' }
  | { flowId: string; outcome: 'duplicate' }
  | { flowId: string; outcome: 'skipped'; reason: string }
  | { flowId: string; outcome: 'failed'; error: string }

export type DispatchActivityEventResult = {
  /** Event was skipped before any flow scan (selfOrigin/backfill/depth cap/not found). */
  skipped?: string
  outcomes: FlowDispatchOutcome[]
}

function isP2002(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

/**
 * Match a persisted `ActivityEvent` against every flow subscribed to it and
 * fire exactly one run per matching flow, exactly once ever.
 *
 * Called ONLY from the outbox's `activity.dispatch` delivery (src/lib/
 * outbox.ts) — never inline from a webhook route. Idempotent: the outbox
 * itself may redeliver (worker crash, stale-lock reclaim), and this function
 * is safe to call again for the same event — every flow it already fully
 * handled (dispatched, throttled, or failed) hits `ActivityTriggerClaim`'s
 * unique `[organizationId, activityEventId, flowId]` index and is skipped.
 */
export async function dispatchActivityEvent(activityEventId: string): Promise<DispatchActivityEventResult> {
  // systemPrisma: the caller supplies only an id — the owning org isn't known
  // until this read returns it, so there is nothing to scope a tenant-guarded
  // query by yet. Every query after this one carries the row's own
  // organizationId and goes through the tenant-guarded `prisma`, exactly like
  // emitFlowSignal.
  const event = await systemPrisma.activityEvent.findUnique({ where: { id: activityEventId } })
  if (!event) {
    apiLogger.warn('dispatchActivityEvent: event not found, skipping', { activityEventId })
    return { skipped: 'not-found', outcomes: [] }
  }

  if (event.selfOrigin) return { skipped: 'self-origin', outcomes: [] }
  if (event.backfill) return { skipped: 'backfill', outcomes: [] }
  if (event.chainDepth >= ACTIVITY_CHAIN_DEPTH_CAP) {
    apiLogger.warn('dispatchActivityEvent: chain depth cap reached, dropping event', {
      activityEventId,
      organizationId: event.organizationId,
      chainDepth: event.chainDepth,
    })
    return { skipped: 'depth-cap', outcomes: [] }
  }

  const subject = isRecord(event.subject) ? event.subject : {}

  // Indexed query: organizationId + activitySource narrows on the
  // [organizationId, activitySource] index; publishedGraph/status/kind are
  // additional WHERE clauses on the same scan, not separately indexed — same
  // "cheap SQL filter, no JSON decode per row" shape as the schedule scan in
  // dispatch-tick.ts.
  const flows = await prisma.flow.findMany({
    where: {
      organizationId: event.organizationId,
      status: 'ACTIVE',
      publishedGraph: { not: Prisma.AnyNull },
      activitySource: event.source,
      activityKinds: { has: event.kind },
    },
    select: { id: true, organizationId: true, userId: true, trigger: true },
    take: MAX_FLOWS_PER_EVENT,
  })
  if (flows.length === MAX_FLOWS_PER_EVENT) {
    apiLogger.warn('dispatchActivityEvent: matching-flow scan hit its cap — listeners beyond it will not match', {
      activityEventId,
      organizationId: event.organizationId,
      source: event.source,
      kind: event.kind,
      cap: MAX_FLOWS_PER_EVENT,
    })
  }

  const outcomes: FlowDispatchOutcome[] = []

  for (const flow of flows) {
    try {
      const trigger = (isRecord(flow.trigger) ? flow.trigger : {}) as ActivityFlowTrigger
      // Actor filter lives here (not matchesEventFilters) because it reads the
      // EVENT, not its subject blob.
      if (trigger.type === 'activity') {
        const filters = isRecord(trigger.filters) ? trigger.filters : {}
        if (
          typeof filters.actorExternalId === 'string' &&
          filters.actorExternalId.trim() &&
          event.actorExternalId !== filters.actorExternalId
        ) {
          outcomes.push({ flowId: flow.id, outcome: 'skipped', reason: 'actor-filter' })
          continue
        }
      }
      if (!matchesEventFilters(trigger, subject)) {
        outcomes.push({ flowId: flow.id, outcome: 'skipped', reason: 'subject-filter' })
        continue
      }
      // Webhook-style input convention: `{ input: ... }` wins, otherwise the
      // whole payload is the flow input — same shaping flowInputFromWebhookBody
      // gives an actual HTTP webhook body. Reused rather than re-invented so an
      // activity-triggered flow's `trigger.input` behaves exactly like a
      // webhook-triggered one's, and so a provider payload that happens to be
      // wrapped `{ input: ... }` (e.g. a flow re-posting its own shape) is
      // honored the same way.
      const input = flowInputFromWebhookBody(event.payload)
      if (!triggerConditionPasses(trigger, input)) {
        outcomes.push({ flowId: flow.id, outcome: 'skipped', reason: 'condition' })
        continue
      }

      // Rolling per-flow throttle: count this flow's claims (any status) in
      // the trailing hour using the [organizationId, flowId, createdAt] index.
      const hourAgo = new Date(Date.now() - 60 * 60_000)
      const recentClaims = await prisma.activityTriggerClaim.count({
        where: { organizationId: event.organizationId, flowId: flow.id, createdAt: { gte: hourAgo } },
      })
      if (recentClaims >= activityRunsPerFlowPerHour()) {
        try {
          await prisma.activityTriggerClaim.create({
            data: { organizationId: event.organizationId, activityEventId: event.id, flowId: flow.id, status: 'throttled' },
          })
        } catch (error) {
          // P2002 on [organizationId, activityEventId, flowId]: this event
          // already produced a terminal claim (throttled/dispatched/failed) or
          // an in-flight one for this flow — exactly-once, nothing to do.
          if (!isP2002(error)) throw error
        }
        outcomes.push({ flowId: flow.id, outcome: 'throttled' })
        continue
      }

      // The exactly-once gate: create the claim BEFORE doing anything that
      // has a side effect. A conflict here means some earlier attempt (this
      // call or a redelivered one) already fully owns this event+flow pair.
      let claim: { id: string } | null = null
      try {
        claim = await prisma.activityTriggerClaim.create({
          data: { organizationId: event.organizationId, activityEventId: event.id, flowId: flow.id, status: 'claimed' },
          select: { id: true },
        })
      } catch (error) {
        if (!isP2002(error)) throw error
        // See the module doc comment / STALE_CLAIM_MS: surface a stranded
        // 'claimed' row so it's diagnosable, without ever re-dispatching it —
        // that would risk a double-fire, which exactly-once must never do.
        const existing = await prisma.activityTriggerClaim.findFirst({
          where: { organizationId: event.organizationId, activityEventId: event.id, flowId: flow.id },
          select: { status: true, createdAt: true },
        })
        if (existing?.status === 'claimed' && Date.now() - existing.createdAt.getTime() > STALE_CLAIM_MS) {
          apiLogger.warn(
            'dispatchActivityEvent: found a stale claimed row for this event+flow — a previous dispatch likely crashed before starting the run; skipping rather than risk a double-fire',
            { activityEventId, flowId: flow.id, organizationId: event.organizationId, claimedAt: existing.createdAt },
          )
        }
        outcomes.push({ flowId: flow.id, outcome: 'duplicate' })
        continue
      }

      // Owner-attribution ladder: flow.userId when active, else the org's
      // oldest active member — identical to emitFlowSignal's lookup.
      const owner = flow.userId
        ? await prisma.user.findFirst({ where: { id: flow.userId, organizationId: flow.organizationId, isActive: true } })
        : await prisma.user.findFirst({ where: { organizationId: flow.organizationId, isActive: true }, orderBy: { createdAt: 'asc' } })
      if (!owner) {
        apiLogger.warn('dispatchActivityEvent: no active user to attribute the run to, skipping flow', {
          flowId: flow.id,
          organizationId: event.organizationId,
          activityEventId,
        })
        await prisma.activityTriggerClaim.updateMany({
          where: { id: claim.id, organizationId: event.organizationId, status: 'claimed' },
          data: { status: 'failed' },
        })
        outcomes.push({ flowId: flow.id, outcome: 'skipped', reason: 'no active owner' })
        continue
      }

      try {
        const flowTriggerType: 'activity' | 'slack' = trigger.type === 'slack' ? 'slack' : 'activity'
        const chainDepth = event.chainDepth + 1
        const result = await dispatchFlowExecution({
          flowId: flow.id,
          organizationId: event.organizationId,
          userId: owner.id,
          input,
          usePublished: true,
          trigger: {
            type: flowTriggerType,
            activityEventId: event.id,
            subject,
            chainDepth,
            // Feeds runScopeKey (side-effect-ledger.ts): scopes this run's
            // idempotency ledger by the EVENT, not the run id, so a replay of
            // this exact event+flow pair (should the claim guard above ever be
            // bypassed) replays recorded side effects instead of re-firing
            // them — same reasoning as poll-dispatch's dedupeValue.
            dedupeValue: event.id,
          },
          deliveryId: `${event.id}-${flow.id}`,
        })
        const flowRunId = 'flowRunId' in result ? result.flowRunId : null
        await prisma.activityTriggerClaim.updateMany({
          where: { id: claim.id, organizationId: event.organizationId, status: 'claimed' },
          data: { status: 'dispatched', flowRunId },
        })
        outcomes.push({ flowId: flow.id, outcome: 'dispatched', flowRunId })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await prisma.activityTriggerClaim.updateMany({
          where: { id: claim.id, organizationId: event.organizationId, status: 'claimed' },
          data: { status: 'failed' },
        })
        apiLogger.warn('dispatchActivityEvent: flow dispatch failed, continuing with other matches', {
          flowId: flow.id,
          organizationId: event.organizationId,
          activityEventId,
          error: message,
        })
        outcomes.push({ flowId: flow.id, outcome: 'failed', error: message })
      }
    } catch (error) {
      // Outermost per-flow guard: anything unexpected (a malformed trigger
      // shape, a throttle-count query error) must not stop the loop — one
      // flow's failure never blocks the rest, same invariant emitFlowSignal
      // keeps.
      const message = error instanceof Error ? error.message : String(error)
      apiLogger.warn('dispatchActivityEvent: unexpected error matching flow, continuing with other matches', {
        flowId: flow.id,
        organizationId: event.organizationId,
        activityEventId,
        error: message,
      })
      outcomes.push({ flowId: flow.id, outcome: 'failed', error: message })
    }
  }

  return { outcomes }
}

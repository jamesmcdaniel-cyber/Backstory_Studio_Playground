import { Prisma } from '@prisma/client'
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { recordAudit } from '@/lib/audit'

export const OUTBOX_TOPIC_FLOW_SIGNAL = 'flow.signal'
export const OUTBOX_TOPIC_CREDENTIAL_REVOKE = 'credential.revoke'
/**
 * Durable handoff from an activity-event receiver (Slack Events API, Task 4;
 * Nango forward/sync, Task 3) to the dispatcher that matches a persisted
 * `ActivityEvent` against subscriptions and runs whatever should react to it
 * — `dispatchActivityEvent` in src/lib/activity/dispatch.ts (Task 6), routed
 * to below in `deliver()`.
 */
export const OUTBOX_TOPIC_ACTIVITY_DISPATCH = 'activity.dispatch'
/**
 * One audit event, forwarded to one customer-configured destination. Rides the
 * outbox rather than a fire-and-forget fetch because an audit event dropped
 * while a receiver was down for an hour is the one kind of gap that matters.
 */
export const OUTBOX_TOPIC_AUDIT_STREAM = 'audit.stream'
const MAX_ATTEMPTS = 8
const CLAIM_TIMEOUT_MS = 10 * 60_000

export type FlowSignalPayload = {
  signal: string
  payload: unknown
  sourceFlowId?: string
  depth?: number
}

/**
 * Deleting a revoked user's OAuth grant at Nango, durably.
 *
 * Not done inline during deprovisioning on purpose: it is a network call, and
 * an admin suspending a hostile account must never be blocked by a vendor
 * outage. The local revocation commits immediately; this catches up.
 *
 * On exhaustion the row survives in `failed` status carrying the connection id
 * in aggregateId — that row IS the record that a grant is still live upstream,
 * which is what makes an un-revoked credential visible instead of silent.
 */
export function credentialRevokeOutboxEvent(input: {
  organizationId: string
  connectionId: string
  providerConfigKey: string
  userId: string
}) {
  return {
    organizationId: input.organizationId,
    topic: OUTBOX_TOPIC_CREDENTIAL_REVOKE,
    aggregateId: input.connectionId,
    // A revoke HAS a natural idempotency key, unlike provider events: deleting
    // the same grant twice is meaningless.
    dedupeKey: `credential-revoke:${input.connectionId}`,
    payload: {
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
      userId: input.userId,
    } as Prisma.InputJsonValue,
  }
}

export function flowSignalOutboxEvent(input: {
  organizationId: string
  aggregateId: string
  dedupeKey: string
  signal: FlowSignalPayload
}) {
  return {
    organizationId: input.organizationId,
    topic: OUTBOX_TOPIC_FLOW_SIGNAL,
    aggregateId: input.aggregateId,
    dedupeKey: input.dedupeKey,
    payload: JSON.parse(JSON.stringify(input.signal)) as Prisma.InputJsonValue,
  }
}

/**
 * A Nango provider event (sync/forward) as a durable `provider.<app>` flow
 * signal. Previously emitted inline from the webhook route: a transient
 * failure was logged, acked ok to Nango, and the event was gone — Nango never
 * retries an acked delivery.
 *
 * `dedupeKey` used to be null here with a comment that provider events carry
 * no natural idempotency key. That stopped being true once the webhook route
 * started persisting every delivery as an `ActivityEvent` first: that row's
 * own unique key is `[organizationId, source, sourceEventId]`, and `source`/
 * `sourceEventId` are exactly what the normalizer already computed (a stable
 * hash when the provider itself supplies no id) — so the same triple is
 * reused here instead of leaving the outbox signal undeduplicated.
 */
export function providerSignalOutboxEvent(input: {
  organizationId: string
  connectionId: string
  providerConfigKey: string
  event: string
  model?: string
  records: unknown
  source: string
  sourceEventId: string
}) {
  return {
    organizationId: input.organizationId,
    topic: OUTBOX_TOPIC_FLOW_SIGNAL,
    aggregateId: input.connectionId,
    dedupeKey: `activity:${input.source}:${input.sourceEventId}`,
    payload: JSON.parse(
      JSON.stringify({
        signal: `provider.${input.providerConfigKey}`,
        payload: {
          provider: input.providerConfigKey,
          connectionId: input.connectionId,
          event: input.event,
          model: input.model,
          records: input.records,
        },
      }),
    ) as Prisma.InputJsonValue,
  }
}

/**
 * A persisted `ActivityEvent`'s durable handoff to `dispatchActivityEvent`
 * (src/lib/activity/dispatch.ts, Task 6). `dedupeKey` reuses the same
 * `[source, sourceEventId]` pairing
 * the `ActivityEvent` row's own unique key is built from — same reasoning as
 * `providerSignalOutboxEvent` above: a redelivery hits this outbox row's own
 * `[organizationId, dedupeKey]` unique constraint and is acked, not
 * duplicated.
 */
export function auditStreamOutboxEvent(input: {
  organizationId: string
  destinationId: string
  auditEventId: string
  body: Record<string, unknown>
}) {
  return {
    organizationId: input.organizationId,
    topic: OUTBOX_TOPIC_AUDIT_STREAM,
    aggregateId: input.auditEventId,
    // Per destination: a receiver that keeps failing must not hold up delivery
    // to one that is healthy.
    dedupeKey: `audit-stream:${input.destinationId}:${input.auditEventId}`,
    payload: { destinationId: input.destinationId, body: input.body } as Prisma.InputJsonValue,
  }
}

export function activityDispatchOutboxEvent(input: {
  organizationId: string
  activityEventId: string
  source: string
  sourceEventId: string
}) {
  return {
    organizationId: input.organizationId,
    topic: OUTBOX_TOPIC_ACTIVITY_DISPATCH,
    aggregateId: input.activityEventId,
    dedupeKey: `activity-dispatch:${input.source}:${input.sourceEventId}`,
    payload: {
      activityEventId: input.activityEventId,
      source: input.source,
      sourceEventId: input.sourceEventId,
    } as Prisma.InputJsonValue,
  }
}

export function outboxRetryDelayMs(attempts: number): number {
  return Math.min(60 * 60_000, 1_000 * 2 ** Math.max(0, attempts - 1))
}

function parseSignalPayload(value: Prisma.JsonValue): FlowSignalPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid flow signal outbox payload')
  const record = value as Record<string, Prisma.JsonValue>
  if (typeof record.signal !== 'string' || !record.signal.trim()) throw new Error('Missing outbox signal name')
  return {
    signal: record.signal,
    payload: record.payload,
    ...(typeof record.sourceFlowId === 'string' ? { sourceFlowId: record.sourceFlowId } : {}),
    ...(typeof record.depth === 'number' ? { depth: record.depth } : {}),
  }
}

function isActivityDispatchPayload(value: Prisma.JsonValue): value is { activityEventId: string } {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).activityEventId === 'string'
}

async function deliver(event: { id: string; organizationId: string; topic: string; payload: Prisma.JsonValue }) {
  if (event.topic === OUTBOX_TOPIC_CREDENTIAL_REVOKE) {
    const { handleCredentialRevoke } = await import('@/lib/nango/revoke-connection')
    await handleCredentialRevoke(event.organizationId, event.payload)
    return
  }
  if (event.topic === OUTBOX_TOPIC_AUDIT_STREAM) {
    const { deliverAuditStream, isAuditStreamPayload } = await import('@/lib/audit/stream-delivery')
    if (!isAuditStreamPayload(event.payload)) throw new Error('Invalid audit.stream outbox payload')
    await deliverAuditStream(event.organizationId, event.payload)
    return
  }
  if (event.topic === OUTBOX_TOPIC_ACTIVITY_DISPATCH) {
    const payload = isActivityDispatchPayload(event.payload) ? event.payload : null
    if (!payload) throw new Error('Invalid activity.dispatch outbox payload')
    // Mentions run AGENTS as the asking human; dispatchActivityEvent fans out to
    // FLOWS and attributes runs to the flow owner. Different question, different
    // path — see src/lib/slack/mention-dispatch.ts.
    const { systemPrisma } = await import('@/lib/prisma')
    const row = await systemPrisma.activityEvent.findUnique({
      where: { id: payload.activityEventId },
      select: { kind: true },
    })
    if (row?.kind === 'agent.mentioned') {
      const { dispatchSlackMention } = await import('@/lib/slack/mention-dispatch')
      await dispatchSlackMention(payload.activityEventId)
      return
    }
    const { dispatchActivityEvent } = await import('@/lib/activity/dispatch')
    await dispatchActivityEvent(payload.activityEventId)
    return
  }
  if (event.topic !== OUTBOX_TOPIC_FLOW_SIGNAL) throw new Error(`Unsupported outbox topic: ${event.topic}`)
  const signal = parseSignalPayload(event.payload)
  const { emitFlowSignal } = await import('@/features/flows/signals')
  await emitFlowSignal({ ...signal, organizationId: event.organizationId, deliveryId: event.id, strictDelivery: true })
}

function isRecordNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025'
}

/** Claim and deliver a bounded batch. Compare-and-set claims make this safe to
 * run from every worker and the cron fallback concurrently. */
export async function processOutboxBatch(limit = 50, now = new Date()): Promise<{ delivered: number; retried: number; failed: number }> {
  const staleLock = new Date(now.getTime() - CLAIM_TIMEOUT_MS)
  // systemPrisma: cross-tenant infrastructure queue, bounded and cron/worker-only.
  const candidates = await systemPrisma.outboxEvent.findMany({
    where: {
      availableAt: { lte: now },
      OR: [{ status: 'pending' }, { status: 'processing', lockedAt: { lt: staleLock } }],
    },
    orderBy: { availableAt: 'asc' },
    take: Math.max(1, Math.min(limit, 200)),
  })
  let deliveredCount = 0
  let retried = 0
  let failed = 0
  for (const event of candidates) {
    // systemPrisma: compare-and-set claim for a globally selected outbox row.
    const claim = await systemPrisma.outboxEvent.updateMany({
      where: {
        id: event.id,
        OR: [{ status: 'pending' }, { status: 'processing', lockedAt: { lt: staleLock } }],
      },
      data: { status: 'processing', lockedAt: now, attempts: { increment: 1 } },
    })
    if (claim.count === 0) continue
    const attempts = event.attempts + 1
    try {
      await deliver(event)
      // systemPrisma: terminal write for the claimed infrastructure row. The
      // row can legitimately vanish between the claim above and this write —
      // its owning Organization was deleted (onDelete: Cascade) while
      // delivery was in flight. That is a fine terminal state by
      // definition (nothing left to mark 'delivered'), so a P2025 here is
      // swallowed rather than left to propagate out of the whole batch loop
      // (see the catch branch's own P2025 handling below for why this
      // matters: an uncaught throw here would abort every OTHER candidate
      // still waiting in this batch, not just this one row).
      try {
        await systemPrisma.outboxEvent.update({
          where: { id: event.id },
          data: { status: 'delivered', deliveredAt: new Date(), lockedAt: null, lastError: null },
        })
      } catch (updateError) {
        if (!isRecordNotFound(updateError)) throw updateError
        apiLogger.warn('outbox row vanished after successful delivery — its aggregate was likely deleted concurrently', {
          outboxEventId: event.id,
          topic: event.topic,
        })
      }
      deliveredCount += 1
    } catch (error) {
      const terminal = attempts >= MAX_ATTEMPTS
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 300)
      // systemPrisma: retry/dead-letter transition for the claimed
      // infrastructure row. Same vanished-row race as the success path above
      // — delivery itself failed AND the row disappeared out from under this
      // write (e.g. its Organization was deleted mid-flight). Nothing to
      // retry or dead-letter for a row that no longer exists, so this is
      // swallowed too, rather than crashing the rest of the batch.
      try {
        await systemPrisma.outboxEvent.update({
          where: { id: event.id },
          data: {
            status: terminal ? 'failed' : 'pending',
            availableAt: terminal ? now : new Date(now.getTime() + outboxRetryDelayMs(attempts)),
            lockedAt: null,
            lastError: message,
          },
        })
      } catch (updateError) {
        if (!isRecordNotFound(updateError)) throw updateError
        apiLogger.warn('outbox row vanished after a failed delivery attempt — its aggregate was likely deleted concurrently', {
          outboxEventId: event.id,
          topic: event.topic,
          attempts,
        })
      }
      if (terminal && event.topic === OUTBOX_TOPIC_CREDENTIAL_REVOKE) {
        // The grant is STILL LIVE at the provider. The failed row carries the
        // connection id in aggregateId, so this is recoverable rather than lost
        // — but it has to be VISIBLE. A silently un-revoked OAuth grant is the
        // exact thing the revocation spine exists to make impossible.
        await recordAudit({
          organizationId: event.organizationId,
          action: 'credential.revoke_failed',
          actorKind: 'system',
          resourceType: 'nango_connection',
          resourceId: event.aggregateId,
          detail: { attempts, lastError: message },
        })
      }
      if (terminal) failed += 1
      else retried += 1
      apiLogger.warn('outbox delivery failed', { outboxEventId: event.id, topic: event.topic, attempts, terminal, error: message })
    }
  }
  return { delivered: deliveredCount, retried, failed }
}

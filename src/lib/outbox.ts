import { Prisma } from '@prisma/client'
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { recordAudit } from '@/lib/audit'
import { decryptSecret, encryptSecret } from '@/lib/crypto/secrets'

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
 * A one-time public wait callback accepted by the web plane. The route consumes
 * the capability token and writes this row in the SAME database transaction,
 * so a Redis/worker outage can delay a resume but can never lose it. The reply
 * is encrypted because callback bodies routinely contain customer data and the
 * generic outbox table is infrastructure storage, not a user-facing run log.
 */
export const OUTBOX_TOPIC_FLOW_RESUME = 'flow.resume'
/**
 * One audit event, forwarded to one customer-configured destination. Rides the
 * outbox rather than a fire-and-forget fetch because an audit event dropped
 * while a receiver was down for an hour is the one kind of gap that matters.
 */
export const OUTBOX_TOPIC_AUDIT_STREAM = 'audit.stream'
/**
 * One task, delivered to one external agent's webhook (signed per attempt).
 * The body is encrypted: it is the task itself — customer content — plus the
 * single-use reply token, and this table is infrastructure storage.
 */
export const OUTBOX_TOPIC_EXTERNAL_AGENT_TASK = 'agent.external.task'
/**
 * An external agent's run was settled (its reply accepted, its deadline
 * passed, or its delivery given up on): resume it through the normal
 * completion path — the flow that owns it, or the bare agent run. Written in
 * the SAME transaction that consumed the reply token, so an outage can delay
 * the completion but never lose an accepted reply.
 */
export const OUTBOX_TOPIC_EXTERNAL_AGENT_SETTLE = 'agent.external.settle'
const MAX_ATTEMPTS = 8

/**
 * Attempts before a row is dead-lettered. A task delivery gives up sooner —
 * the run is waiting on it and fails with the reason — while a settle keeps
 * trying for longer, since it may be waiting for its flow to finish pausing.
 */
export function maxOutboxAttempts(topic: string): number {
  if (topic === OUTBOX_TOPIC_EXTERNAL_AGENT_TASK) return 5
  if (topic === OUTBOX_TOPIC_EXTERNAL_AGENT_SETTLE) return 12
  return MAX_ATTEMPTS
}

/**
 * A delivery failure that retrying cannot fix (an endpoint refusing the
 * request, a URL the SSRF guard will never allow). The row is dead-lettered
 * on the first attempt instead of hammering a receiver that already said no.
 */
export class PermanentOutboxError extends Error {
  readonly permanent = true
  constructor(message: string) {
    super(message)
    this.name = 'PermanentOutboxError'
  }
}

function isPermanentOutboxError(error: unknown): boolean {
  return Boolean(error) && typeof error === 'object' && (error as { permanent?: unknown }).permanent === true
}

export function externalAgentTaskOutboxEvent(input: { organizationId: string; executionId: string; encryptedBody: string }) {
  return {
    organizationId: input.organizationId,
    topic: OUTBOX_TOPIC_EXTERNAL_AGENT_TASK,
    aggregateId: input.executionId,
    // One task per execution: a re-delivered dispatch collides here.
    dedupeKey: `external-task:${input.executionId}`,
    payload: { executionId: input.executionId, encryptedBody: input.encryptedBody } as Prisma.InputJsonValue,
  }
}

export function externalAgentSettleOutboxEvent(input: { organizationId: string; executionId: string }) {
  return {
    organizationId: input.organizationId,
    topic: OUTBOX_TOPIC_EXTERNAL_AGENT_SETTLE,
    aggregateId: input.executionId,
    // A run settles once: the token consume that writes this row is single-use.
    dedupeKey: `external-settle:${input.executionId}`,
    payload: { executionId: input.executionId } as Prisma.InputJsonValue,
  }
}
const CLAIM_TIMEOUT_MS = 10 * 60_000

export type FlowSignalPayload = {
  signal: string
  payload: unknown
  sourceFlowId?: string
  depth?: number
}

type FlowResumePayload = {
  flowId: string
  flowRunId: string
  userId: string
  encryptedReply: string
}

export function flowResumeOutboxEvent(input: {
  organizationId: string
  flowId: string
  flowRunId: string
  userId: string
  resumeTokenHash: string
  reply: string
}) {
  return {
    organizationId: input.organizationId,
    topic: OUTBOX_TOPIC_FLOW_RESUME,
    aggregateId: input.flowRunId,
    // A run may wait on more than one webhook over its lifetime. The one-way
    // token hash identifies this particular pause without persisting the
    // capability itself, while still deduplicating concurrent delivery.
    dedupeKey: `flow-resume:${input.flowRunId}:${input.resumeTokenHash}`,
    payload: {
      flowId: input.flowId,
      flowRunId: input.flowRunId,
      userId: input.userId,
      encryptedReply: encryptSecret(input.reply),
    } as Prisma.InputJsonValue,
  }
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

function isFlowResumePayload(value: Prisma.JsonValue): value is FlowResumePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const payload = value as Record<string, unknown>
  return (
    typeof payload.flowId === 'string' &&
    typeof payload.flowRunId === 'string' &&
    typeof payload.userId === 'string' &&
    typeof payload.encryptedReply === 'string'
  )
}

async function deliver(event: { id: string; organizationId: string; topic: string; payload: Prisma.JsonValue }) {
  if (event.topic === OUTBOX_TOPIC_EXTERNAL_AGENT_TASK) {
    const { deliverExternalTask, isExternalTaskPayload } = await import('@/lib/agents/external/delivery')
    if (!isExternalTaskPayload(event.payload)) throw new Error('Invalid agent.external.task outbox payload')
    await deliverExternalTask(event.organizationId, event.payload)
    return
  }
  if (event.topic === OUTBOX_TOPIC_EXTERNAL_AGENT_SETTLE) {
    const { deliverExternalSettle, isExternalSettlePayload } = await import('@/lib/agents/external/settle')
    if (!isExternalSettlePayload(event.payload)) throw new Error('Invalid agent.external.settle outbox payload')
    await deliverExternalSettle(event.organizationId, event.payload, event.id)
    return
  }
  if (event.topic === OUTBOX_TOPIC_FLOW_RESUME) {
    if (!isFlowResumePayload(event.payload)) throw new Error('Invalid flow.resume outbox payload')
    const { dispatchFlowExecution } = await import('@/features/flows/execute-flow')
    await dispatchFlowExecution({
      flowId: event.payload.flowId,
      flowRunId: event.payload.flowRunId,
      organizationId: event.organizationId,
      userId: event.payload.userId,
      input: {},
      reply: decryptSecret(event.payload.encryptedReply),
      // Stable across an ambiguous queue handoff and every outbox retry.
      deliveryId: event.id,
    })
    return
  }
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
    const outcome = await claimAndDeliver(event, now, staleLock)
    if (outcome === 'delivered') deliveredCount += 1
    else if (outcome === 'retried') retried += 1
    else if (outcome === 'failed') failed += 1
  }
  return { delivered: deliveredCount, retried, failed }
}

/**
 * Process ONE outbox row now, when it is due — the immediate first attempt
 * for a row whose writer is waiting on it (an external agent's task, a
 * settled reply). Same claim, delivery and retry bookkeeping as the batch, so
 * a failure here is retried by the poller exactly like any other row.
 */
export async function processOutboxEventById(id: string, now = new Date()): Promise<'delivered' | 'retried' | 'failed' | 'skipped'> {
  const staleLock = new Date(now.getTime() - CLAIM_TIMEOUT_MS)
  // systemPrisma: id-keyed read of an infrastructure row the caller just wrote.
  const event = await systemPrisma.outboxEvent.findUnique({ where: { id } })
  if (!event || event.availableAt > now) return 'skipped'
  return claimAndDeliver(event, now, staleLock)
}

type OutboxRow = {
  id: string
  organizationId: string
  topic: string
  aggregateId: string | null
  attempts: number
  payload: Prisma.JsonValue
}

async function claimAndDeliver(event: OutboxRow, now: Date, staleLock: Date): Promise<'delivered' | 'retried' | 'failed' | 'skipped'> {
  // systemPrisma: compare-and-set claim for a globally selected outbox row.
  const claim = await systemPrisma.outboxEvent.updateMany({
    where: {
      id: event.id,
      OR: [{ status: 'pending' }, { status: 'processing', lockedAt: { lt: staleLock } }],
    },
    data: { status: 'processing', lockedAt: now, attempts: { increment: 1 } },
  })
  if (claim.count === 0) return 'skipped'
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
    return 'delivered'
  } catch (error) {
    const terminal = attempts >= maxOutboxAttempts(event.topic) || isPermanentOutboxError(error)
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
    if (terminal && event.topic === OUTBOX_TOPIC_EXTERNAL_AGENT_TASK) {
      // The run is waiting on a task that will now never arrive: fail it
      // with the reason, through the normal completion path, rather than
      // leaving it to time out an hour from now.
      const { externalDeliveryGaveUp } = await import('@/lib/agents/external/delivery')
      await externalDeliveryGaveUp(event.organizationId, event.payload, message).catch((gaveUpError) =>
        apiLogger.error('external agent delivery give-up failed', {
          outboxEventId: event.id,
          error: gaveUpError instanceof Error ? gaveUpError.message : String(gaveUpError),
        }),
      )
    }
    apiLogger.warn('outbox delivery failed', { outboxEventId: event.id, topic: event.topic, attempts, terminal, error: message })
    return terminal ? 'failed' : 'retried'
  }
}

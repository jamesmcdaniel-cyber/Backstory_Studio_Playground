import { Prisma } from '@prisma/client'
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

export const OUTBOX_TOPIC_FLOW_SIGNAL = 'flow.signal'
const MAX_ATTEMPTS = 8
const CLAIM_TIMEOUT_MS = 10 * 60_000

export type FlowSignalPayload = {
  signal: string
  payload: unknown
  sourceFlowId?: string
  depth?: number
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

async function deliver(event: { id: string; organizationId: string; topic: string; payload: Prisma.JsonValue }) {
  if (event.topic !== OUTBOX_TOPIC_FLOW_SIGNAL) throw new Error(`Unsupported outbox topic: ${event.topic}`)
  const signal = parseSignalPayload(event.payload)
  const { emitFlowSignal } = await import('@/features/flows/signals')
  await emitFlowSignal({ ...signal, organizationId: event.organizationId, deliveryId: event.id, strictDelivery: true })
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
      // systemPrisma: terminal write for the claimed infrastructure row.
      await systemPrisma.outboxEvent.update({
        where: { id: event.id },
        data: { status: 'delivered', deliveredAt: new Date(), lockedAt: null, lastError: null },
      })
      deliveredCount += 1
    } catch (error) {
      const terminal = attempts >= MAX_ATTEMPTS
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 300)
      // systemPrisma: retry/dead-letter transition for the claimed infrastructure row.
      await systemPrisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          status: terminal ? 'failed' : 'pending',
          availableAt: terminal ? now : new Date(now.getTime() + outboxRetryDelayMs(attempts)),
          lockedAt: null,
          lastError: message,
        },
      })
      if (terminal) failed += 1
      else retried += 1
      apiLogger.warn('outbox delivery failed', { outboxEventId: event.id, topic: event.topic, attempts, terminal, error: message })
    }
  }
  return { delivered: deliveredCount, retried, failed }
}

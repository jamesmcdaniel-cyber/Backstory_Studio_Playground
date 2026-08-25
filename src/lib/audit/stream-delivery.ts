import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { decryptSecret } from '@/lib/crypto/secrets'
import { assertPublicUrl, SsrfError } from '@/lib/net/ssrf'
import {
  STREAM_SIGNATURE_HEADER,
  STREAM_TIMESTAMP_HEADER,
  signStreamDelivery,
  type AuditEventForStream,
} from '@/lib/audit/stream'

/**
 * One audit event, delivered to one destination.
 *
 * Called by the outbox, so retries, backoff and the attempt ceiling are already
 * handled: this throws on a failure and the outbox decides what to do about it.
 * An audit event dropped because a customer's endpoint was down for an hour is
 * the one kind of gap that matters, which is why it rides the outbox rather
 * than a fire-and-forget fetch at the call site.
 */
export type AuditStreamPayload = {
  destinationId: string
  body: Record<string, unknown>
}

export function isAuditStreamPayload(value: unknown): value is AuditStreamPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.destinationId === 'string' && Boolean(candidate.body) && typeof candidate.body === 'object'
}

const DELIVERY_TIMEOUT_MS = 10_000

export async function deliverAuditStream(organizationId: string, payload: AuditStreamPayload): Promise<void> {
  const destination = await systemPrisma.auditStreamDestination.findFirst({
    where: { id: payload.destinationId, organizationId },
    select: { id: true, url: true, secret: true, isActive: true },
  })
  // Deleted or switched off between enqueue and delivery. Not an error: the
  // customer said stop, and retrying would argue with them.
  if (!destination || !destination.isActive) return

  // Re-checked at delivery, not only at save: this is a caller-supplied URL our
  // server posts to, and a host that resolved publicly yesterday can resolve
  // into a private range today.
  try {
    await assertPublicUrl(destination.url)
  } catch (error) {
    if (error instanceof SsrfError) {
      await systemPrisma.auditStreamDestination
        .update({
          where: { id: destination.id },
          data: { isActive: false, lastError: 'The destination URL is not allowed. Set a public https endpoint.' },
        })
        .catch(() => undefined)
      // Deliberately NOT thrown: retrying a blocked address eight times is
      // eight more attempts to reach somewhere we already decided not to go.
      apiLogger.warn('audit stream destination disabled: URL not allowed', { destinationId: destination.id })
      return
    }
    throw error
  }

  const body = JSON.stringify(payload.body)
  const timestamp = Math.floor(Date.now() / 1000)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    [STREAM_TIMESTAMP_HEADER]: String(timestamp),
  }
  if (destination.secret) {
    headers[STREAM_SIGNATURE_HEADER] = signStreamDelivery(decryptSecret(destination.secret), body, timestamp)
  }

  const response = await fetch(destination.url, {
    method: 'POST',
    headers,
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  })

  if (!response.ok) {
    await systemPrisma.auditStreamDestination
      .update({ where: { id: destination.id }, data: { lastError: `HTTP ${response.status}` } })
      .catch(() => undefined)
    // Thrown so the outbox retries with its own backoff.
    throw new Error(`Audit stream delivery failed with HTTP ${response.status}`)
  }

  await systemPrisma.auditStreamDestination
    .update({ where: { id: destination.id }, data: { lastDeliveredAt: new Date(), lastError: null } })
    .catch(() => undefined)
}

/**
 * Queue one audit event to every destination that wants it.
 *
 * Never throws: an audit write must not fail because a customer's forwarding
 * endpoint is misconfigured. The trail in our own database is the record of
 * last resort and it is already written by the time this runs.
 */
export async function enqueueAuditStream(event: AuditEventForStream): Promise<void> {
  try {
    const [{ destinationWants, streamPayload }, { auditStreamOutboxEvent }] = await Promise.all([
      import('@/lib/audit/stream'),
      import('@/lib/outbox'),
    ])
    const destinations = await systemPrisma.auditStreamDestination.findMany({
      where: { organizationId: event.organizationId, isActive: true },
      select: { id: true, actionPrefixes: true, isActive: true },
    })
    if (!destinations.length) return

    const body = streamPayload(event)
    for (const destination of destinations) {
      if (!destinationWants(destination, event.action)) continue
      await systemPrisma.outboxEvent.create({
        data: auditStreamOutboxEvent({
          organizationId: event.organizationId,
          destinationId: destination.id,
          auditEventId: event.id,
          body,
        }),
      })
    }
  } catch (error) {
    apiLogger.warn('audit stream enqueue failed', {
      action: event.action,
      organizationId: event.organizationId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

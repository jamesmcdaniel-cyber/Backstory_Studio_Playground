import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Forwarding the audit trail to a customer's own system.
 *
 * The trail has always been complete; it lived only in our database, so
 * answering "show us your logs in OUR SIEM" meant an export by hand. This is
 * the pure half — which events a destination wants, what the delivered body
 * looks like, and how it is signed. Delivery itself rides the outbox, which
 * already has claiming, backoff and a retry ceiling.
 */

export type StreamDestination = {
  id: string
  /** Action prefixes this destination wants. Empty means everything. */
  actionPrefixes: readonly string[]
  isActive: boolean
}

export type AuditEventForStream = {
  id: string
  action: string
  organizationId: string
  actorUserId?: string | null
  actorKind?: string | null
  resourceType?: string | null
  resourceId?: string | null
  executionId?: string | null
  ip?: string | null
  createdAt: Date
  detail?: unknown
}

/**
 * Does this destination want this event?
 *
 * Prefix matching on the action, because our actions are already namespaced
 * (`flow.published`, `credential.rotated`) and a customer asking for "just the
 * credential events" is asking for a prefix. An empty list means everything,
 * which is what someone setting up a SIEM feed almost always wants.
 *
 * Matching is on a segment boundary: `flow` must not select `flowsomething`,
 * or a later namespace would silently join a feed nobody asked to widen.
 */
export function destinationWants(destination: StreamDestination, action: string): boolean {
  if (!destination.isActive) return false
  if (destination.actionPrefixes.length === 0) return true
  return destination.actionPrefixes.some((prefix) => {
    const clean = prefix.trim().replace(/\.$/, '')
    if (!clean) return false
    return action === clean || action.startsWith(`${clean}.`)
  })
}

/**
 * The body a destination receives.
 *
 * Deliberately NOT the raw row. `detail` is a JSON grab-bag written by dozens of
 * call sites, and forwarding it verbatim to a third party is how something
 * nobody audited leaves the building. What ships is the fixed, reviewed shape:
 * who did what to which resource, when, from where.
 */
export function streamPayload(event: AuditEventForStream): Record<string, unknown> {
  return {
    id: event.id,
    type: 'audit.event',
    action: event.action,
    occurredAt: event.createdAt.toISOString(),
    organizationId: event.organizationId,
    actor: {
      userId: event.actorUserId ?? null,
      kind: event.actorKind ?? 'user',
      ip: event.ip ?? null,
    },
    resource: {
      type: event.resourceType ?? null,
      id: event.resourceId ?? null,
    },
    executionId: event.executionId ?? null,
  }
}

/**
 * Sign a delivery so a receiver can tell our POST from anyone else who learns
 * the URL.
 *
 * The timestamp is signed WITH the body: a signature over the body alone can be
 * replayed forever by anyone who captured one, and a log feed is exactly where
 * a replayed event would be believed.
 */
export function signStreamDelivery(secret: string, body: string, timestampSeconds: number): string {
  return createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex')
}

/** How long a signed delivery stays acceptable, for a receiver checking it. */
export const STREAM_SIGNATURE_TOLERANCE_SECONDS = 300

/**
 * Verify one — used by our own tests and by anyone implementing a receiver.
 *
 * Constant-time, and only after the length check, because `timingSafeEqual`
 * throws on a length mismatch rather than returning false.
 */
export function verifyStreamDelivery(params: {
  secret: string
  body: string
  timestampSeconds: number
  signature: string
  nowSeconds: number
}): boolean {
  const age = Math.abs(params.nowSeconds - params.timestampSeconds)
  if (!Number.isFinite(age) || age > STREAM_SIGNATURE_TOLERANCE_SECONDS) return false
  const expected = signStreamDelivery(params.secret, params.body, params.timestampSeconds)
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(params.signature, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

export const STREAM_SIGNATURE_HEADER = 'x-backstory-signature'
export const STREAM_TIMESTAMP_HEADER = 'x-backstory-timestamp'

/**
 * Pure normalizers for the activity-event substrate (see
 * docs/superpowers/specs/2026-08-21-activity-event-substrate-design.md).
 *
 * These functions turn provider-shaped payloads (Slack Events API envelopes,
 * Nango sync/forward payloads) into the single `NormalizedActivity` shape
 * that `ActivityEvent` rows are built from. They do NO I/O: no prisma, no
 * fetch, no `Date.now()`. Any timestamp that can't be parsed out of the
 * payload falls back to the caller-supplied `opts.receivedAt` (the caller —
 * the webhook receiver — is the one allowed to read the clock), never to a
 * clock read inside this module. If a caller omits `receivedAt` AND the
 * payload carries no parseable timestamp, `occurredAt` falls back to the
 * Unix epoch (`new Date(0)`) — callers should always pass `receivedAt` to
 * avoid this degenerate case.
 *
 * Style follows `mapEventToSignal` (src/lib/signals/map.ts): defensive
 * multi-key extraction across flat/nested payload shapes, and a `sha256:`
 * content-hash fallback for `sourceEventId` when the provider doesn't supply
 * a stable event id.
 *
 * Payload capping: the raw payload is JSON-serialized and measured. If the
 * serialized form is within `PAYLOAD_MAX_CHARS`, the original value is kept
 * as-is (still valid JSON for the `Json` column). If it's oversized, the
 * *stored* payload becomes a small wrapper object —
 * `{ truncated: true, originalLength, preview }` — where `preview` is
 * `truncateWithMarker(serialized, PAYLOAD_MAX_CHARS)`. This keeps the marker
 * text (`… [truncated N chars]`) inside what's actually persisted (the
 * `preview` string), while keeping the persisted value valid JSON (a plain
 * `.slice()` of a JSON string is not guaranteed to itself be valid JSON, so
 * the truncated text is carried as a string field rather than as the whole
 * payload value).
 */

import crypto from 'node:crypto'
import { truncateWithMarker } from '@/lib/flows/truncate'

/** Small, documented verb vocabulary — never a freeform provider string. */
export const ACTIVITY_KINDS = [
  'message.posted',
  'record.created',
  'record.updated',
  'record.deleted',
  'pr.opened',
  'pr.closed',
  'pr.merged',
  'issue.opened',
  'issue.closed',
  'push',
  /** Fallback for any shape we don't have a specific mapping for yet. */
  'generic',
] as const

export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

export interface NormalizedActivity {
  source: string
  sourceEventId: string
  kind: ActivityKind
  occurredAt: Date
  actorExternalId: string | null
  /** Always null out of these pure normalizers — the caller (which resolves
   *  the connection/mirror row) fills in the owning rep. */
  ownerUserId: string | null
  subject: Record<string, unknown>
  payload: unknown
  selfOrigin: boolean
  chainDepth: number
}

const PAYLOAD_MAX_CHARS = 50_000

export interface NormalizeOpts {
  /** The workspace's own bot user id, captured at connect time. Slack events
   *  authored by this identity (or carrying any `bot_id`) are `selfOrigin`. */
  botUserId?: string
  /** Fallback timestamp when the payload carries none. Caller-supplied so
   *  this module never reads the clock itself. */
  receivedAt?: Date
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function firstString(sources: Record<string, unknown>[], keys: string[]): string | null {
  for (const source of sources) {
    for (const key of keys) {
      const value = source[key]
      if (typeof value === 'string' && value) return value
      if (typeof value === 'number') return String(value)
    }
  }
  return null
}

function firstNumber(sources: Record<string, unknown>[], keys: string[]): number | null {
  for (const source of sources) {
    for (const key of keys) {
      const value = source[key]
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
    }
  }
  return null
}

function sha256Id(prefix: string, payload: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(`${prefix}:${JSON.stringify(payload)}`).digest('hex')}`
}

function capPayload(raw: unknown): unknown {
  let serialized: string
  try {
    serialized = JSON.stringify(raw ?? null) ?? 'null'
  } catch {
    // Circular or otherwise unserializable — fall back to a safe stand-in
    // rather than throwing out of a pure normalizer.
    return { truncated: true, originalLength: 0, preview: '[unserializable payload]' }
  }
  if (serialized.length <= PAYLOAD_MAX_CHARS) return raw
  return {
    truncated: true,
    originalLength: serialized.length,
    preview: truncateWithMarker(serialized, PAYLOAD_MAX_CHARS),
  }
}

/** Slack `ts`/`event_ts` values are decimal-seconds strings like
 *  "1691000000.000100". Also tolerates a plain unix-seconds number. */
function parseSlackTimestamp(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value * 1000)
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return new Date(n * 1000)
  }
  return null
}

function chainDepthFromMetadata(event: Record<string, unknown>): number {
  // Flow-posted Slack messages carry `metadata.event_payload.chainDepth`
  // (chat.postMessage `metadata` field) so a reply chain the flow itself
  // authored can be depth-capped on the way back in.
  const metadata = asRecord(event.metadata)
  const eventPayload = asRecord(metadata.event_payload)
  const depth = eventPayload.chainDepth
  return typeof depth === 'number' && Number.isFinite(depth) ? depth : 0
}

/**
 * Normalize a Slack Events API `event_callback` envelope
 * (`{ team_id, event: { type, user, bot_id, channel, ts, thread_ts, ... },
 * event_id, event_time }`) into a `NormalizedActivity`, or `null` if the
 * envelope carries no recognizable event.
 */
export function normalizeSlackEvent(orgId: string, envelope: unknown, opts: NormalizeOpts = {}): NormalizedActivity | null {
  void orgId // not part of the output shape; reserved for future per-org logic
  const outer = asRecord(envelope)
  const event = asRecord(outer.event)
  const type = firstString([event], ['type'])
  if (!type) return null

  const kind: ActivityKind = type === 'message' ? 'message.posted' : 'generic'

  const userId = firstString([event], ['user'])
  const botId = firstString([event], ['bot_id'])
  const actorExternalId = userId ?? botId ?? null
  const selfOrigin = Boolean(botId) || (opts.botUserId != null && userId === opts.botUserId)

  const occurredAt =
    parseSlackTimestamp(event.event_ts ?? event.ts) ??
    (firstNumber([outer], ['event_time']) != null ? new Date((firstNumber([outer], ['event_time']) as number) * 1000) : null) ??
    opts.receivedAt ??
    new Date(0)

  const sourceEventId = firstString([outer], ['event_id']) ?? sha256Id(type, outer)

  return {
    source: 'slack',
    sourceEventId,
    kind,
    occurredAt,
    actorExternalId,
    ownerUserId: null,
    subject: {
      channelId: firstString([event], ['channel']),
      threadTs: firstString([event], ['thread_ts']),
    },
    payload: capPayload(outer),
    selfOrigin,
    chainDepth: chainDepthFromMetadata(event),
  }
}

function normalizeSalesforce(payload: Record<string, unknown>): { kind: ActivityKind; subject: Record<string, unknown>; actorExternalId: string | null } {
  const recordId = firstString([payload], ['recordId', 'record_id', 'id', 'Id'])
  const changeType = firstString([payload], ['changeType', 'change_type', 'eventType', 'event_type', 'type'])
  let kind: ActivityKind = 'record.updated'
  const normalizedChangeType = changeType?.toUpperCase() ?? ''
  if (normalizedChangeType.includes('CREATE')) kind = 'record.created'
  else if (normalizedChangeType.includes('DELETE')) kind = 'record.deleted'
  else if (normalizedChangeType.includes('UPDATE')) kind = 'record.updated'
  return {
    kind,
    subject: { recordId, sobject: firstString([payload], ['sobject', 'sobjectType', 'entityName']) },
    actorExternalId: firstString([payload], ['modifiedById', 'lastModifiedById', 'changedById', 'userId', 'actorId']),
  }
}

function normalizeGithub(payload: Record<string, unknown>): { kind: ActivityKind; subject: Record<string, unknown>; actorExternalId: string | null } {
  const pullRequest = asRecord(payload.pull_request)
  const issue = asRecord(payload.issue)
  const repository = asRecord(payload.repository)
  const action = firstString([payload], ['action'])
  const repo = firstString([repository], ['full_name', 'name'])

  let kind: ActivityKind = 'generic'
  let subject: Record<string, unknown> = { repo }

  if (Object.keys(pullRequest).length > 0) {
    if (action === 'opened') kind = 'pr.opened'
    else if (action === 'closed') kind = pullRequest.merged === true ? 'pr.merged' : 'pr.closed'
    subject = { repo, prNumber: pullRequest.number ?? null }
  } else if (Object.keys(issue).length > 0) {
    if (action === 'opened') kind = 'issue.opened'
    else if (action === 'closed') kind = 'issue.closed'
    subject = { repo, issueNumber: issue.number ?? null }
  } else if (Array.isArray(payload.commits) || payload.ref !== undefined) {
    kind = 'push'
    subject = { repo, ref: firstString([payload], ['ref']) }
  }

  const actorExternalId = firstString(
    [asRecord(payload.sender), asRecord(pullRequest.user), asRecord(issue.user)],
    ['login', 'id'],
  )

  return { kind, subject, actorExternalId }
}

/**
 * Normalize a Nango sync/forward payload for a given `provider` into a
 * `NormalizedActivity`. Salesforce and GitHub get provider-specific field
 * mappings; any other provider (or an unrecognized shape for a known
 * provider) falls back to `kind: 'generic'` with best-effort id extraction —
 * never `null` just because the shape is unfamiliar (only a payload that
 * yields nothing usable at all still needs a stable id, which the sha256
 * fallback provides).
 */
export function normalizeNangoForward(
  orgId: string,
  provider: string,
  payload: unknown,
  opts: { receivedAt?: Date } = {},
): NormalizedActivity | null {
  void orgId // not part of the output shape; reserved for future per-org logic
  const data = asRecord(payload)
  const providerKey = provider.toLowerCase()

  let mapped: { kind: ActivityKind; subject: Record<string, unknown>; actorExternalId: string | null }
  let source: string
  if (providerKey.includes('salesforce')) {
    source = 'salesforce'
    mapped = normalizeSalesforce(data)
  } else if (providerKey.includes('github')) {
    source = 'github'
    mapped = normalizeGithub(data)
  } else {
    source = `nango:${provider}`
    mapped = {
      kind: 'generic',
      subject: {},
      actorExternalId: firstString([data], ['actor_id', 'actorId', 'user_id', 'userId', 'sender']),
    }
  }

  const occurredAt =
    (() => {
      const iso = firstString([data], ['occurred_at', 'occurredAt', 'timestamp', 'created_at', 'createdAt'])
      if (iso) {
        const d = new Date(iso)
        if (!Number.isNaN(d.getTime())) return d
      }
      const epochSeconds = firstNumber([data], ['event_time', 'eventTime'])
      if (epochSeconds != null) return new Date(epochSeconds * 1000)
      return null
    })() ??
    opts.receivedAt ??
    new Date(0)

  const eventId = firstString([data], ['id', 'event_id', 'eventId', 'delivery_id', 'deliveryId'])
  const sourceEventId = eventId ?? sha256Id(`${provider}:${mapped.kind}`, data)

  return {
    source,
    sourceEventId,
    kind: mapped.kind,
    occurredAt,
    actorExternalId: mapped.actorExternalId,
    ownerUserId: null,
    subject: mapped.subject,
    payload: capPayload(data),
    selfOrigin: false,
    chainDepth: 0,
  }
}

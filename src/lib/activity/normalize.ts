/**
 * Pure normalizers for the activity-event substrate (see
 * docs/superpowers/specs/2026-08-21-activity-event-substrate-design.md).
 *
 * These functions turn provider-shaped payloads (Slack Events API envelopes,
 * Nango sync/forward payloads) into the single `NormalizedActivity` shape
 * that `ActivityEvent` rows are built from. They do NO I/O: no prisma, no
 * fetch, no `Date.now()`. Any timestamp that can't be parsed out of the
 * payload falls back to `opts.receivedAt`, which is a REQUIRED parameter —
 * the caller (the webhook receiver, the one I/O boundary allowed to read the
 * clock) must supply it. This is deliberate: an optional fallback that quietly
 * defaulted to the Unix epoch when both the payload and the caller omitted a
 * timestamp would silently stamp bogus 1970 dates with no marker, which is
 * worse than a compile error — making `receivedAt` required makes that
 * degenerate path unrepresentable instead of documented-and-hoped-against,
 * while keeping this module itself clock-free.
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

/**
 * Shared opts for both producers. `botUserId` is Slack-specific (ignored by
 * `normalizeNangoForward`); `receivedAt` is required by both — it's the only
 * clock read either function is allowed to rely on, and it must come from
 * the caller.
 */
export interface NormalizeOpts {
  /** The workspace's own bot user id, captured at connect time. Slack events
   *  authored by this identity (or carrying any `bot_id`) are `selfOrigin`. */
  botUserId?: string
  /** Fallback timestamp when the payload carries none. Required: the I/O
   *  boundary (webhook receiver) must supply it so this module never reads
   *  the clock and never fabricates a timestamp. */
  receivedAt: Date
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
 *
 * `sourceEventId` derivation order — and why it's `channel:ts` FIRST, not
 * Slack's own `event_id`: the backfill worker (src/lib/activity/backfill.ts)
 * ingests the exact same messages from `conversations.history`, which carries
 * no `event_id` at all (only Events API deliveries do). For live and
 * backfilled ingestion of the SAME message to dedupe into one row —
 * across the two entirely different transports — they have to agree on one
 * identity scheme, and the only field both transports carry is
 * `channel` + `ts` (Slack's own stable identity for a message: edits keep
 * the same `ts`). So: `channel` + `ts` present (every message event has
 * both) → `slack:msg:<channel>:<ts>`, unaffected by whether this is a live
 * delivery or a backfilled page. Only event *subtypes* that carry neither
 * (no `message` event lacks them, but plenty of other Slack event types do)
 * fall back to `event_id`, then to the `sha256:` content hash.
 */
export function normalizeSlackEvent(orgId: string, envelope: unknown, opts: NormalizeOpts): NormalizedActivity | null {
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
    opts.receivedAt

  const channelId = firstString([event], ['channel'])
  const ts = firstString([event], ['ts'])
  const sourceEventId =
    channelId && ts ? `slack:msg:${channelId}:${ts}` : (firstString([outer], ['event_id']) ?? sha256Id(type, outer))

  return {
    source: 'slack',
    sourceEventId,
    kind,
    occurredAt,
    actorExternalId,
    ownerUserId: null,
    subject: {
      channelId,
      threadTs: firstString([event], ['thread_ts']),
    },
    payload: capPayload(outer),
    selfOrigin,
    chainDepth: chainDepthFromMetadata(event),
  }
}

/**
 * Normalize one Slack `conversations.history` message object (Task 7's
 * backfill worker, src/lib/activity/backfill.ts) into a `NormalizedActivity`.
 *
 * Slack's history API returns message objects, not Events API envelopes — a
 * history message has no `event_id`, no `team_id`, and (unlike a live event)
 * no `channel` field of its own (the channel is implicit in the request that
 * fetched it). Rather than duplicate `normalizeSlackEvent`'s field mapping,
 * this wraps a message into the same `{ event: {...} }` shape that function
 * already knows how to read — folding the known channel id into the wrapped
 * event so both `subject.channelId` AND `sourceEventId` come out populated —
 * and delegates to it entirely. This keeps exactly one place that knows how
 * to read a Slack message's fields AND exactly one place that decides its
 * identity: `normalizeSlackEvent` already derives `slack:msg:<channel>:<ts>`
 * whenever both are present (every message carries both, live or backfilled),
 * which is precisely the scheme that makes live ingestion and backfill of the
 * SAME message collide into one row instead of two — no override needed here
 * at all. See `normalizeSlackEvent`'s own doc comment for why that scheme
 * (not `event_id`, which history messages never carry) was chosen.
 */
export function normalizeSlackHistoryMessage(
  orgId: string,
  message: unknown,
  channelId: string,
  opts: NormalizeOpts,
): NormalizedActivity | null {
  const record = asRecord(message)
  const envelope = { event: { ...record, type: record.type ?? 'message', channel: channelId } }
  return normalizeSlackEvent(orgId, envelope, opts)
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
  opts: NormalizeOpts,
): NormalizedActivity | null {
  void orgId // not part of the output shape; reserved for future per-org logic
  const data = asRecord(payload)
  // `provider` is caller-supplied and not guaranteed to be a string at
  // runtime (a malformed webhook forward, a bad call site) — never throw
  // out of a pure normalizer just because a required-looking arg was
  // null/undefined.
  const providerKey = String(provider ?? '').toLowerCase()

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
    opts.receivedAt

  const eventId = firstString([data], ['id', 'event_id', 'eventId', 'delivery_id', 'deliveryId'])
  // The hash prefix includes `mapped.kind`, not just the raw provider/type —
  // deliberate, but it's a tradeoff worth flagging: if a future change
  // refines the kind heuristics (e.g. a payload that used to fall through to
  // `generic` starts resolving to a specific kind), the hash-derived
  // `sourceEventId` for that same payload changes too. That's fine for a
  // *new* delivery (first-seen either way) but means a *redelivery* of an
  // event that previously hashed under the old kind will no longer match the
  // `@@unique([organizationId, source, sourceEventId])` row from before the
  // heuristic change, and will insert as a "new" event rather than dedupe
  // against it. Only matters for providers without a stable id field at all
  // (most do supply one); accepted because kind precision is worth more here
  // than dedupe stability across a heuristic refinement of an id-less shape.
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

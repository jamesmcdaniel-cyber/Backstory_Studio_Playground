/**
 * Cursor-checkpointed backfill worker (Task 7 of
 * docs/superpowers/specs/2026-08-21-activity-event-substrate-design.md).
 *
 * Pages a source's read API from the stored `ActivitySourceCursor`, persists
 * `ActivityEvent` rows (`backfill: true`), and advances the cursor — and does
 * so in that order, every page: persist first, checkpoint after. A crash
 * between those two steps re-fetches and re-normalizes the same page on the
 * next run; the unique index on `[organizationId, source, sourceEventId]`
 * (enforced here via `createMany({ skipDuplicates: true })`) makes that
 * re-ingestion idempotent rather than a duplicate row. This is the inverse of
 * `dispatchActivityEvent`'s ordering (claim BEFORE side effect) for the
 * opposite reason: here the side effect (persisting rows) is itself
 * idempotent, so it is safe to redo, while advancing the cursor past
 * unpersisted rows would NOT be safe (it would silently skip that page of
 * history forever) — so cursor writes are always the LAST thing a page does.
 *
 * Backfilled events never fire triggers: `backfill: true` on every row is
 * belt-and-braces alongside `dispatchActivityEvent`'s own `event.backfill`
 * skip (Task 6) — and, just as importantly, this module never writes an
 * `activity.dispatch` outbox row at all. There is nothing for the dispatcher
 * to even be asked to skip.
 *
 * ── Slack transport choice ──────────────────────────────────────────────────
 *
 * Slack read reaches this codebase through two independent planes:
 *  1. The native `src/lib/integrations/slack.ts` plane: a per-org bot token
 *     resolved via `resolveOrgCredential` (workspace's own `IntegrationSecret`
 *     row, or the internal/partner env fallback), used today only for posting
 *     (`chat.postMessage`) and for verifying the Events API receiver's
 *     signature. It has no read tools and no `connectionId` concept at all —
 *     one token per org, not per connection.
 *  2. The Nango plane (`src/lib/nango/delivery.ts` + `provider-tools.ts`):
 *     `NangoConnection` rows, one per connected account, addressed by
 *     `(organizationId, connectionId, providerConfigKey)`. `slack_read_messages`
 *     and `slack_list_channels` (provider-tools.ts) already read through this
 *     plane via `conversations.history` / `conversations.list`.
 *
 * `ActivitySourceCursor` is keyed by `(organizationId, source, connectionId)`
 * — a `connectionId` is exactly the Nango plane's addressing scheme, and has
 * no equivalent on the native plane (which is one-token-per-org, not
 * per-connection). So this worker resolves the specific `NangoConnection` row
 * named by the caller's `connectionId` and re-uses the SAME proxy calls
 * `slack_read_messages`/`slack_list_channels` make (same endpoint, same
 * param shapes) — not the native plane's token, and not the agent tool layer
 * (no approval gate, no tool-call ledger; this is a background job reading
 * history, not an agent action).
 */

import { Prisma } from '@prisma/client'
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { defaultProxy, slackData, type NangoProxy } from '@/lib/nango/delivery'
import { PROVIDER_CONFIG_KEYS } from '@/lib/nango/provider-tools'
import { normalizeSlackHistoryMessage, type NormalizedActivity } from '@/lib/activity/normalize'

/** Hard ceiling on events persisted per job invocation — the admin trigger
 *  re-enqueues rather than one job walking a workspace's entire history in a
 *  single (unboundedly long) run. */
export const BACKFILL_MAX_EVENTS_PER_JOB = 2000

/** Messages requested per `conversations.history` call. Slack's own max is
 *  1000; kept well under it so one page's normalize+persist work stays small. */
const SLACK_HISTORY_PAGE_LIMIT = 200

/**
 * Hard cap on API round-trips per job, independent of `BACKFILL_MAX_EVENTS_PER_JOB`.
 * The event cap alone does not guarantee termination: a channel whose history
 * is exhausted but whose transport (a bug, or a mocked test double) keeps
 * returning an empty page with a non-empty `messages` array of duplicates
 * would persist zero NEW rows forever while never tripping the event cap.
 * This is the actual "no infinite loop on a static cursor" guarantee — pages
 * are counted on every iteration regardless of how many rows it persisted.
 */
const MAX_PAGES_PER_JOB = 500

export type BackfillOutcome =
  | { status: 'ok'; source: string; connectionId: string; persisted: number; pages: number; cappedAtEventLimit: boolean; cappedAtPageLimit: boolean }
  | { status: 'unsupported'; source: string; connectionId: string; reason: string }
  | { status: 'no-connection'; source: string; connectionId: string }

export interface BackfillDeps {
  /** Injectable Nango proxy — tests substitute a mock transport. */
  proxy?: NangoProxy
  /** Injectable clock — tests assert against a fixed `receivedAt`/`lastBackfilledAt`. */
  now?: () => Date
}

interface SlackChannelCursor {
  id: string
  /** Slack's own `response_metadata.next_cursor` for this channel, or `null`
   *  at the start of its history. */
  cursor: string | null
  /** True once a page for this channel came back with no messages and no
   *  further cursor — its history (as of this backfill) is exhausted. */
  done: boolean
}

interface SlackBackfillCursor {
  channels: SlackChannelCursor[]
  /** True once `conversations.list` has been called at least once — the
   *  channel roster itself is fetched once per (organizationId, connectionId)
   *  cursor lifetime, not re-listed every job. */
  listed: boolean
}

function isSlackCursor(value: unknown): value is SlackBackfillCursor {
  return Boolean(
    value &&
      typeof value === 'object' &&
      Array.isArray((value as { channels?: unknown }).channels) &&
      typeof (value as { listed?: unknown }).listed === 'boolean',
  )
}

function extractChannelIds(data: unknown): string[] {
  const channels = (data && typeof data === 'object' ? (data as { channels?: unknown }).channels : null) ?? []
  if (!Array.isArray(channels)) return []
  return channels
    .map((channel) => (channel && typeof channel === 'object' ? (channel as { id?: unknown }).id : null))
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
}

async function upsertCursor(organizationId: string, connectionId: string, cursor: SlackBackfillCursor, now: Date): Promise<void> {
  await systemPrisma.activitySourceCursor.upsert({
    where: { organizationId_source_connectionId: { organizationId, source: 'slack', connectionId } },
    create: { organizationId, source: 'slack', connectionId, cursor: cursor as unknown as Prisma.InputJsonValue, lastBackfilledAt: now },
    update: { cursor: cursor as unknown as Prisma.InputJsonValue, lastBackfilledAt: now },
  })
}

/**
 * Backfill a single Slack `NangoConnection`. Slack-only for real (see the
 * file-level doc comment); other sources are stubbed in `runActivityBackfill`
 * below behind the same interface.
 */
async function runSlackBackfill(organizationId: string, connectionId: string, deps: BackfillDeps): Promise<BackfillOutcome> {
  const now = deps.now ?? (() => new Date())

  const connection = await systemPrisma.nangoConnection.findFirst({
    where: {
      organizationId,
      connectionId,
      providerConfigKey: { in: [...PROVIDER_CONFIG_KEYS.slack] },
      status: 'connected',
    },
  })
  if (!connection) {
    apiLogger.warn('runActivityBackfill: no connected Slack NangoConnection for this id', { organizationId, connectionId })
    return { status: 'no-connection', source: 'slack', connectionId }
  }

  // Constructed only once a real connection exists — defaultProxy() throws
  // when Nango itself isn't configured for this environment at all, which
  // must never mask the more specific (and more common) "this connectionId
  // isn't a connected Slack connection" outcome above.
  const proxy = deps.proxy ?? defaultProxy()

  const cursorRow = await systemPrisma.activitySourceCursor.findUnique({
    where: { organizationId_source_connectionId: { organizationId, source: 'slack', connectionId } },
  })
  let state: SlackBackfillCursor = isSlackCursor(cursorRow?.cursor) ? cursorRow.cursor : { channels: [], listed: false }

  if (!state.listed) {
    const listed = await proxy({
      method: 'GET',
      endpoint: '/conversations.list',
      connectionId: connection.connectionId,
      providerConfigKey: connection.providerConfigKey,
      params: { limit: 200, types: 'public_channel,private_channel' },
    })
    const channelIds = extractChannelIds(slackData(listed.data))
    state = { channels: channelIds.map((id) => ({ id, cursor: null, done: false })), listed: true }
    // Not event data — nothing gates this write on "persist first". Losing it
    // to a crash just costs one extra conversations.list call on retry.
    await upsertCursor(organizationId, connectionId, state, now())
  }

  let persisted = 0
  let pages = 0

  while (persisted < BACKFILL_MAX_EVENTS_PER_JOB && pages < MAX_PAGES_PER_JOB) {
    const channel = state.channels.find((c) => !c.done)
    if (!channel) break // every known channel's history is exhausted for now

    pages += 1
    const response = await proxy({
      method: 'GET',
      endpoint: '/conversations.history',
      connectionId: connection.connectionId,
      providerConfigKey: connection.providerConfigKey,
      params: channel.cursor
        ? { channel: channel.id, limit: SLACK_HISTORY_PAGE_LIMIT, cursor: channel.cursor }
        : { channel: channel.id, limit: SLACK_HISTORY_PAGE_LIMIT },
    })
    const data = slackData(response.data) as { messages?: unknown[]; response_metadata?: { next_cursor?: unknown } }
    const messages = Array.isArray(data.messages) ? data.messages : []

    if (messages.length === 0) {
      channel.done = true
      await upsertCursor(organizationId, connectionId, state, now())
      continue
    }

    const receivedAt = now()
    const rows = messages
      .map((message) => normalizeSlackHistoryMessage(organizationId, message, channel.id, { receivedAt }))
      .filter((row): row is NormalizedActivity => row !== null)

    if (rows.length > 0) {
      const created = await systemPrisma.activityEvent.createMany({
        data: rows.map((row) => ({
          organizationId,
          source: row.source,
          sourceEventId: row.sourceEventId,
          kind: row.kind,
          occurredAt: row.occurredAt,
          actorExternalId: row.actorExternalId,
          // Nango connections are per-user when userId is set (a rep's own
          // connection) and org-shared otherwise — same visibility split the
          // design doc specifies for private-connection events.
          ownerUserId: connection.userId ?? null,
          visibility: connection.userId ? 'private' : 'org',
          selfOrigin: row.selfOrigin,
          backfill: true,
          chainDepth: 0,
          subject: row.subject as Prisma.InputJsonValue,
          payload: row.payload as Prisma.InputJsonValue,
        })),
        skipDuplicates: true,
      })
      persisted += created.count
    }

    // Cursor advance strictly AFTER the createMany above has resolved — see
    // the file-level doc comment on ordering.
    const nextCursor = data.response_metadata?.next_cursor
    if (typeof nextCursor === 'string' && nextCursor) {
      channel.cursor = nextCursor
    } else {
      channel.done = true
    }
    await upsertCursor(organizationId, connectionId, state, now())
  }

  return {
    status: 'ok',
    source: 'slack',
    connectionId,
    persisted,
    pages,
    cappedAtEventLimit: persisted >= BACKFILL_MAX_EVENTS_PER_JOB,
    cappedAtPageLimit: pages >= MAX_PAGES_PER_JOB,
  }
}

/**
 * Backfill one `(organizationId, source, connectionId)` cursor. Slack is the
 * only source with a real read transport wired up (see the file-level doc
 * comment); Salesforce and GitHub are stubbed behind the same interface —
 * per the brief, building a new provider API client is out of scope for this
 * task, so those sources report `'unsupported'` rather than silently no-op
 * succeeding (a caller checking `status` can tell "nothing happened because
 * there's nothing to do yet" from "nothing happened, something broke").
 */
export async function runActivityBackfill(
  organizationId: string,
  source: string,
  connectionId: string,
  deps: BackfillDeps = {},
): Promise<BackfillOutcome> {
  if (source === 'slack') return runSlackBackfill(organizationId, connectionId, deps)

  apiLogger.warn('runActivityBackfill: source has no backfill transport wired up yet', { organizationId, source, connectionId })
  return {
    status: 'unsupported',
    source,
    connectionId,
    reason:
      source === 'salesforce' || source === 'github'
        ? `${source} backfill ships once an existing read transport is available to reuse — no new provider API client is built for it here.`
        : `unknown source '${source}'`,
  }
}

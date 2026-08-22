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
 * ── Slack transport choice: two planes, one resolution order ────────────────
 *
 * Slack read reaches this codebase through two independent planes, and this
 * worker supports BOTH:
 *
 *  1. The NATIVE plane (`src/lib/integrations/slack.ts`): a per-org bot token
 *     saved via `POST /api/integrations/credentials/slack` (Task 4's BYO-app
 *     path) and resolved through `getSlackToken` — one token per org, no
 *     `connectionId` concept at all. This is the platform's PRIMARY Slack
 *     setup: an org on this path has no `NangoConnection` row for Slack, so
 *     resolving only against Nango (this module's original implementation)
 *     made every native-plane org's backfill dead-end at `'no-connection'`.
 *     Reads go straight to `https://slack.com/api/...` via
 *     `nativeSlackGet` — the exact same `conversations.list`/
 *     `conversations.history` endpoints, using the SAME bot token
 *     `post_message` already resolves (`CREDENTIAL_FIELD = 'apiKey'`,
 *     encrypted the same way every other org secret in this codebase is —
 *     nothing new needed persisting here, it was already saved at connect
 *     time).
 *  2. The NANGO plane (`src/lib/nango/delivery.ts` + `provider-tools.ts`):
 *     `NangoConnection` rows, one per connected account, addressed by
 *     `(organizationId, connectionId, providerConfigKey)`. Reads reuse the
 *     SAME proxy calls `slack_read_messages`/`slack_list_channels`
 *     (provider-tools.ts) make — same endpoints, same param shapes — not the
 *     agent tool layer (no approval gate, no tool-call ledger; this is a
 *     background job, not an agent action).
 *
 * `ActivitySourceCursor` keys on `(organizationId, source, connectionId)`,
 * which is exactly the Nango plane's addressing scheme and has no equivalent
 * on the native plane (one token per org, not per connection). Rather than
 * add a second cursor shape, the native plane is addressed with the sentinel
 * `NATIVE_SLACK_CONNECTION_ID` ('native') as its `connectionId` — it slots
 * into the same unique key naturally, and can never collide with a real Nango
 * `connectionId` in practice (Nango's are opaque per-integration ids, not the
 * literal string "native").
 *
 * Resolution order for `runActivityBackfill(orgId, 'slack', connectionId)`:
 *   - `connectionId === NATIVE_SLACK_CONNECTION_ID` → native plane, using
 *     `getSlackToken(organizationId)`. `'no-connection'` if the org has no
 *     saved Slack bot token at all.
 *   - anything else → looked up as a `NangoConnection.connectionId`.
 *     `'no-connection'` if no CONNECTED row matches. (Deliberately NOT a
 *     silent fallback to native on a miss — a caller passing a stale/
 *     mistyped Nango connectionId should see that surfaced, not have it
 *     quietly swallowed into "whichever plane happens to work.")
 * `defaultSlackConnectionId` (below) is the "which one should I use" helper
 * for a caller (the admin trigger route) that wants to auto-select rather
 * than name a specific connectionId: it prefers an existing Nango connection
 * and falls back to the native sentinel only when that's the only Slack
 * plane the org has configured.
 */

import { Prisma } from '@prisma/client'
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { defaultProxy, slackData, type NangoProxy } from '@/lib/nango/delivery'
import { PROVIDER_CONFIG_KEYS } from '@/lib/nango/provider-tools'
import { getSlackToken, nativeSlackGet } from '@/lib/integrations/slack'
import { normalizeSlackHistoryMessage, type NormalizedActivity } from '@/lib/activity/normalize'

/** Sentinel `connectionId` addressing the native (BYO-app) Slack plane —
 *  see the file-level doc comment's resolution order. */
export const NATIVE_SLACK_CONNECTION_ID = 'native'

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
  /** Injectable Nango proxy — tests substitute a mock transport for the Nango plane. */
  proxy?: NangoProxy
  /** Injectable native-plane GET — tests substitute a mock transport for the native plane. */
  nativeGet?: typeof nativeSlackGet
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
  /**
   * True once `conversations.list` has been called at least once — the
   * channel roster itself is fetched once per (organizationId, connectionId)
   * cursor lifetime, not re-listed every job.
   *
   * KNOWN LIMITATION (carry this into the Task 10 runbook): a channel
   * created AFTER this roster snapshot is invisible to this cursor forever —
   * there is no periodic re-list. An operator who needs a newly-created
   * channel backfilled must clear/reset the stored `ActivitySourceCursor`
   * row (or delete it) to force a fresh `conversations.list` on the next run.
   */
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

/** The two calls this worker needs from either Slack plane, already unwrapped
 *  to the raw (unvalidated) Slack response body — `slackData()` validation
 *  happens once, in the shared loop below, so both transports stay this
 *  minimal. */
interface SlackReadTransport {
  listChannels(): Promise<unknown>
  history(channelId: string, cursor: string | null): Promise<unknown>
}

function nangoSlackTransport(connection: { connectionId: string; providerConfigKey: string }, proxy: NangoProxy): SlackReadTransport {
  return {
    listChannels: async () =>
      (
        await proxy({
          method: 'GET',
          endpoint: '/conversations.list',
          connectionId: connection.connectionId,
          providerConfigKey: connection.providerConfigKey,
          params: { limit: 200, types: 'public_channel,private_channel' },
        })
      ).data,
    history: async (channelId, cursor) =>
      (
        await proxy({
          method: 'GET',
          endpoint: '/conversations.history',
          connectionId: connection.connectionId,
          providerConfigKey: connection.providerConfigKey,
          params: cursor ? { channel: channelId, limit: SLACK_HISTORY_PAGE_LIMIT, cursor } : { channel: channelId, limit: SLACK_HISTORY_PAGE_LIMIT },
        })
      ).data,
  }
}

function nativeSlackTransport(token: string, nativeGet: typeof nativeSlackGet): SlackReadTransport {
  return {
    listChannels: () => nativeGet(token, '/conversations.list', { limit: 200, types: 'public_channel,private_channel' }),
    history: (channelId, cursor) =>
      nativeGet(token, '/conversations.history', cursor ? { channel: channelId, limit: SLACK_HISTORY_PAGE_LIMIT, cursor } : { channel: channelId, limit: SLACK_HISTORY_PAGE_LIMIT }),
  }
}

/**
 * The shared paging loop, identical for either plane once a transport is in
 * hand: list channels (once), then page each channel's history, persisting
 * `backfill: true` rows before every cursor advance (see the file-level doc
 * comment on ordering).
 */
async function runSlackBackfillLoop(
  organizationId: string,
  connectionId: string,
  transport: SlackReadTransport,
  attribution: { ownerUserId: string | null; visibility: 'org' | 'private' },
  now: () => Date,
): Promise<BackfillOutcome> {
  const cursorRow = await systemPrisma.activitySourceCursor.findUnique({
    where: { organizationId_source_connectionId: { organizationId, source: 'slack', connectionId } },
  })
  let state: SlackBackfillCursor = isSlackCursor(cursorRow?.cursor) ? cursorRow.cursor : { channels: [], listed: false }

  if (!state.listed) {
    const channelIds = extractChannelIds(slackData(await transport.listChannels()))
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
    const data = slackData(await transport.history(channel.id, channel.cursor)) as {
      messages?: unknown[]
      response_metadata?: { next_cursor?: unknown }
    }
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
          ownerUserId: attribution.ownerUserId,
          visibility: attribution.visibility,
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
 * Backfill Slack for one `(organizationId, connectionId)` target — resolving
 * to the native plane or the Nango plane per the file-level doc comment's
 * resolution order. Salesforce/GitHub are stubbed in `runActivityBackfill`
 * below behind the same interface.
 */
async function runSlackBackfill(organizationId: string, connectionId: string, deps: BackfillDeps): Promise<BackfillOutcome> {
  const now = deps.now ?? (() => new Date())

  if (connectionId === NATIVE_SLACK_CONNECTION_ID) {
    const token = await getSlackToken(organizationId)
    if (!token) {
      apiLogger.warn('runActivityBackfill: native Slack plane requested but org has no saved bot token', { organizationId })
      return { status: 'no-connection', source: 'slack', connectionId }
    }
    const transport = nativeSlackTransport(token.value, deps.nativeGet ?? nativeSlackGet)
    // Native credential is one-token-per-org, always org-shared — no
    // per-connection userId to derive private visibility from (unlike Nango).
    return runSlackBackfillLoop(organizationId, connectionId, transport, { ownerUserId: null, visibility: 'org' }, now)
  }

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
  const transport = nangoSlackTransport(connection, proxy)
  return runSlackBackfillLoop(
    organizationId,
    connectionId,
    transport,
    // Nango connections are per-user when userId is set (a rep's own
    // connection) and org-shared otherwise — same visibility split the
    // design doc specifies for private-connection events.
    { ownerUserId: connection.userId ?? null, visibility: connection.userId ? 'private' : 'org' },
    now,
  )
}

/**
 * Which Slack `connectionId` a caller should backfill when it hasn't named
 * one — the admin trigger route's "auto-select" convenience. Prefers an
 * existing (connected) Nango connection; falls back to the native sentinel
 * only when that's the only Slack plane this org has configured. `null` when
 * neither plane is configured at all.
 */
export async function defaultSlackConnectionId(organizationId: string): Promise<string | null> {
  const connection = await systemPrisma.nangoConnection.findFirst({
    where: { organizationId, providerConfigKey: { in: [...PROVIDER_CONFIG_KEYS.slack] }, status: 'connected' },
    orderBy: { createdAt: 'asc' },
  })
  if (connection) return connection.connectionId
  const token = await getSlackToken(organizationId)
  return token ? NATIVE_SLACK_CONNECTION_ID : null
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

# Activity-event plane runbook

This is the operator runbook for the activity-event substrate: Slack messages
and Nango provider events becoming `ActivityEvent` rows, matching against
published flows, and firing `FlowRun`s. It documents what the code actually
does today — table names, status vocabularies, constants — not aspirations.

Design doc: `docs/superpowers/specs/2026-08-21-activity-event-substrate-design.md`.
Ledger: `.superpowers/sdd/2026-08-21-activity-event-substrate/progress.md`.
Proof: `src/lib/activity/__tests__/activity-e2e.db.test.ts` exercises the
whole path below end to end against a real Postgres.

## 1. The trace path: ingestion → claim → run

```
Slack workspace                Nango (Salesforce/GitHub/etc.)
      │                               │
      ▼                               ▼
POST /api/slack/events        Nango webhook route (Task 3)
(src/app/api/slack/events/route.ts)
      │                               │
      └──────────────┬────────────────┘
                      ▼
          normalizeSlackEvent / normalizeNangoForward
          (src/lib/activity/normalize.ts)
                      │
                      ▼
          ActivityEvent row persisted (activity_events table)
                      │
                      ▼
          OutboxEvent row, topic 'activity.dispatch'
          (outbox_events table — src/lib/outbox.ts)
                      │
          ── durable handoff, delivered by whatever is
             draining the outbox (worker loop or the
             cron fallback) ──
                      │
                      ▼
          dispatchActivityEvent(activityEventId)
          (src/lib/activity/dispatch.ts)
                      │
          ┌───────────┴────────────┐
          ▼                        ▼
  ActivityTriggerClaim row   FlowRun row (via startFlowExecution)
  (activity_trigger_claims)  (flow_runs, created BEFORE inline/
                              queue dispatch is even decided)
```

Every step is a real database row you can query. When a customer says "my
Slack flow didn't fire," walk this path top to bottom:

1. **Did the event arrive at all?**
   ```sql
   select id, source, "sourceEventId", kind, "selfOrigin", backfill, "chainDepth", "createdAt"
   from activity_events
   where "organizationId" = '<org-id>'
   order by "createdAt" desc
   limit 20;
   ```
   Nothing here means the receiver never got the delivery, or it dropped it
   as unnormalizable (see the receiver's own WARN logs: `slack event dropped
   — no recognizable event in envelope`), or the signature failed (`slack
   event verification failed for a connected workspace` — ERROR level,
   Sentry-visible; `slack event dropped — team_id matches no connected
   workspace` — WARN, routine for a disconnected workspace). All three of
   these ack Slack with `200 { ok: true }` regardless — Slack's dashboard
   will show a clean delivery even when nothing was persisted, so logs are
   the only place this is visible.

2. **`sourceEventId` scheme (Slack).** `normalizeSlackEvent` derives it as
   `slack:msg:<channel>:<ts>` whenever the event carries both a channel and a
   Slack `ts` (every `message` event does — live delivery or backfill
   history alike), falling back to Slack's own `event_id` and finally a
   `sha256:`-prefixed content hash only for event subtypes lacking both. This
   is deliberate: it's what lets a live-ingested message and a later
   backfill pass over the same history collide on one row instead of two.

3. **Did it reach the outbox?**
   ```sql
   select id, topic, status, attempts, "availableAt", "lastError"
   from outbox_events
   where "organizationId" = '<org-id>' and "dedupeKey" like 'activity-dispatch:%'
   order by "createdAt" desc
   limit 20;
   ```
   `status` is one of `pending` / `processing` / `delivered` / `failed`.
   `pending` past its `availableAt` with `attempts > 0` means delivery kept
   throwing and is backing off (`outboxRetryDelayMs`: exponential, capped at
   1 hour); `failed` means it exhausted `MAX_ATTEMPTS` (8) — `lastError`
   carries the truncated (300-char) exception message from the last attempt.
   `processing` with an old `lockedAt` (older than `CLAIM_TIMEOUT_MS`, 10
   minutes) means a worker died mid-delivery; the next drain reclaims it
   automatically (compare-and-set on `status IN (pending, processing)` with
   a stale lock).

4. **Did it match a flow?**
   ```sql
   select id, "flowId", status, "flowRunId", "createdAt"
   from activity_trigger_claims
   where "organizationId" = '<org-id>' and "activityEventId" = '<event-id>';
   ```
   No row at all means `dispatchActivityEvent` never even reached the
   per-flow loop for this event — check the event's own `selfOrigin` /
   `backfill` / `chainDepth` columns from step 1 (see §2) and whether any
   flow's `activitySource`/`activityKinds` actually matches this event's
   `source`/`kind` (`select id, name, status, "activitySource",
   "activityKinds" from flows where "organizationId" = '<org-id>' and status
   = 'ACTIVE'`). A flow only matches if it is `ACTIVE`, has a
   `publishedGraph`, and its `activitySource`/`activityKinds` columns —
   built by `activityMatchColumns()` in `src/lib/flows/trigger.ts` — line up
   with the event's `source`/`kind`. **Seven** call sites write these columns,
   not one: `POST /api/flows` (create), `PUT /api/flows` (every trigger
   edit, including on an already-published flow), `POST /api/flows/[id]/
   publish`, `POST /api/flows/import` (two call sites internally),
   `POST /api/v1/flows` (v1 create), `PUT /api/v1/flows/[id]`, and
   template instantiation (`src/lib/flows/templates/instantiate.ts`). Only
   the publish route ever checked entitlement (§6) — every other site,
   `PUT /api/flows` in particular, syncs these columns on a plain trigger
   edit with NO entitlement check at all, including on a flow that is
   ALREADY `ACTIVE`. That is deliberate: the write path stays permissive so
   editing is never blocked mid-flow; see §6 for where entitlement is
   actually enforced (dispatch time, not write time). If a flow's trigger
   was edited in the builder but never **republished**, its match columns
   are stale (draft `graph` changed, `activitySource`/`activityKinds`
   didn't) — that's the single most common "I changed the trigger and it
   stopped firing" cause.
   A row with `status = 'skipped'`-shaped reasoning doesn't exist as a
   status — "skipped" outcomes (actor/subject/condition filter, no active
   owner) are only visible in the `dispatchActivityEvent` caller's return
   value / logs, not as a claim row, EXCEPT the "no active owner" case,
   which writes a claim and immediately marks it `failed`.

5. **Did it produce a run?**
   A claim with `status = 'dispatched'` always carries a non-null
   `flowRunId` — `dispatchActivityEvent` calls `startFlowExecution`, which
   creates the `FlowRun` row synchronously (queue mode or not) before
   returning, specifically so this claim-to-run link is never null in
   production. `select * from flow_runs where id = '<flowRunId>'` to see how
   it actually executed.

### Claim status vocabulary (`ActivityTriggerClaim.status`)

| Status | Meaning |
|---|---|
| `claimed` | The exactly-once row was created, run dispatch was in progress. If this is the FINAL state you observe (no later `dispatched`/`failed`), the process crashed between claim-create and run-start — see §4 (stale-claim watch). |
| `dispatched` | A `FlowRun` was created; `flowRunId` is populated. |
| `throttled` | The per-flow hourly cap was already met when this event matched; no run was created (see §2). |
| `failed` | Either `startFlowExecution` threw (an error is logged, no run for THIS flow — other matching flows in the same event are unaffected), or no active user could be found to attribute the run to ("owner ladder" failure). |

## 2. Throttle + loop-guard semantics

Four independent guards run in `dispatchActivityEvent`
(`src/lib/activity/dispatch.ts`), checked in this order, before any flow is
matched or after a flow is matched but before a run is created:

- **`selfOrigin`** — an event authored by the connected app's own bot/service
  identity (Slack: `event.user === botUserId` or any `bot_id` present,
  captured at connect time via `auth.test`). Dropped before the flow scan
  even runs (`{ skipped: 'self-origin' }`). This is the primary anti-loop
  guard for "flow posts a Slack reply → that reply itself becomes an
  ActivityEvent → flow fires on itself forever," and it is Slack-only — it
  covers the ONE plane where a flow's own post can be recognized as
  bot-authored on the way back in.
- **`backfill`** — events written by `runActivityBackfill`
  (`src/lib/activity/backfill.ts`, §3) are trigger-silent by construction:
  `dispatchActivityEvent` refuses to match them at all
  (`{ skipped: 'backfill' }`), and in fact no `OutboxEvent` row is ever
  written for a backfilled event in the first place — this guard is belt and
  suspenders. The one exception is documented in §3: a LIVE delivery that
  collides with a row backfill already wrote flips that row's `backfill`
  flag to `false` before driving it through the outbox, precisely so it is
  no longer this guard that's skipping it.
- **`chainDepth` / `ACTIVITY_CHAIN_DEPTH_CAP` (= 3)** — every run started
  from an activity event carries `chainDepth: event.chainDepth + 1` on its
  own trigger. **Slack is the only plane with a depth PRODUCER today**: a
  flow-authored Slack post (native `SlackToolClient.post_message` or the
  Nango-plane `slack_post_message` delivery tool, both in
  `applySlackChainDepthMetadata`, `src/features/flows/tool-args.ts`) stamps
  `chat.postMessage`'s own `metadata` field with the posting run's
  `chainDepth`, and the Slack receiver's `chainDepthFromMetadata`
  (`src/lib/activity/normalize.ts`) reads it straight back off the resulting
  message event — so a Slack-mediated A→B→A→B loop (two different flows
  volleying replies) is capped even though `selfOrigin` alone only catches a
  bot replying to itself. A run NOT started from an activity/slack trigger
  has no `chainDepth` on its `trigger` at all, and a Slack post from such a
  run omits `metadata` entirely — there's nothing to propagate. **No other
  plane propagates chain depth** — a flow's Salesforce/GitHub/other Nango
  writes do not stamp anything analogous, and this is an accepted ruling,
  not a gap to close: every plane's own per-flow hourly throttle (below)
  already bounds runaway looping regardless of how many hops a chain takes,
  so depth-capping is a Slack-specific refinement on top of a guard that
  already exists everywhere. Once an event's `chainDepth >= 3` (Slack only,
  in practice), it's dropped before matching (`{ skipped: 'depth-cap' }`).
- **Entitlement (`canArmEventTriggers`)** — re-checked once per event,
  before the flow scan, against the event's own organization (see §6). An
  un-entitled org's event is dropped (`{ skipped: 'not-entitled' }`) even if
  some flow's `activitySource`/`activityKinds` columns already look armed.

**Per-flow hourly throttle** — `ACTIVITY_RUNS_PER_FLOW_PER_HOUR`
(`src/lib/activity/dispatch.ts`, default 60, env-overridable via the
`ACTIVITY_RUNS_PER_FLOW_PER_HOUR` environment variable, same override
convention as `orgMaxInFlightRuns`). For each matching flow, before creating
the exactly-once claim, the dispatcher counts that flow's OWN claims with
status `dispatched` OR `claimed` in the trailing 60 minutes
(`activity_trigger_claims` where `flowId` = this flow and `createdAt >= now
- 1h` and `status IN ('dispatched', 'claimed')`). At or above the cap, a
`throttled` claim is written instead of a run — visible via the claim-status
query in §1. `throttled` and `failed` claims deliberately do NOT count toward
the cap: counting every status (as this used to) meant a busy channel's
`throttled` claims kept the trailing-hour count pinned at-or-above the cap
forever, starving the flow to zero real dispatches even long after the
busy period ended and its actual (`dispatched`) run rate had dropped back
well under 60/hr. There is no automatic recovery or backlog replay for
throttled events; the flow simply resumes firing once its trailing-hour
`dispatched`/`claimed` count drops back under the cap.

**Exactly-once guarantee.** The claim's unique index —
`[organizationId, activityEventId, flowId]` — is the ONLY thing that makes a
redelivered outbox row (worker crash + stale-lock reclaim, or Slack's own
resend behavior on anything but a clean 200) safe: the claim `create` call
throws Postgres error code `P2002`, which is swallowed and logged as a
`duplicate` outcome, never a second run. This is proven directly in
`activity-e2e.db.test.ts` scenario (b) by putting a delivered outbox row back
to `pending` and re-draining through the real `processOutboxBatch`.

## 3. Backfill operations

**Live/backfill overlap (Slack).** `conversations.history` is newest-first,
so a backfill walk's FIRST pages read the same recent messages the live
Events API receiver may be ingesting at the same time — the two can race on
the identical `[organizationId, source, sourceEventId]` row. If backfill
wins that race (persists the row first, `backfill: true`, no outbox row —
see below), the live delivery's own insert hits a `P2002` conflict. The
receiver (`src/app/api/slack/events/route.ts`) tells this apart from an
ordinary Slack redelivery by re-reading the existing row's own `backfill`
flag: `false` means a real redelivery (ack, nothing else to do); `true`
means THIS message is live now — the receiver flips `backfill` to `false`
(atomic, conditioned on it still being `true`) and drives the SAME row
through the outbox exactly once, so it fires like any other live message
instead of being silently swallowed as a false "redelivery." Backfill itself
is unaffected by this — it never writes an outbox row and this collision
handling doesn't change that.

Backfill (`src/lib/activity/backfill.ts`, `runActivityBackfill`) pages a
connected app's own history into `ActivityEvent` rows, cursor-checkpointed,
**never firing a trigger** (no `OutboxEvent` row is written from this path at
all — see §2).

- **Admin route**: `POST /api/admin/activity/backfill`, body
  `{ organizationId, source, connectionId? }`. Gated `platform.administer` +
  internal-edition-only. Runs inline in dev, on the `activity-backfill`
  BullMQ queue (`QUEUE_NAMES.ACTIVITY_BACKFILL`) when queue mode is on. A
  second trigger for the SAME `(organizationId, source, connectionId)` while
  one is already in flight (inline `Set` guard, or a scan of pending/active/
  delayed jobs' own payload for queue mode) returns `alreadyRunning` rather
  than stacking a duplicate walk.
- **`connectionId` resolution order (Slack only)**: if omitted,
  `defaultSlackConnectionId(organizationId)` picks a real Nango
  `NangoConnection` row for slack if one exists, else falls back to the
  literal string `'native'` (the sentinel for the org's BYO-app bot token —
  see below), else `null` (neither plane configured — the route 400s with a
  clear message). Every other `source` still requires an explicit
  `connectionId`; there is no auto-select for non-Slack sources.
- **Native vs. Nango planes.** Backfill can read Slack history through
  either transport:
  - `connectionId === 'native'` — the org's own BYO-app bot token, the SAME
    token `getSlackToken` decrypts for `slack_post_message` (saved via
    `POST /api/integrations/credentials/slack`, §5). Reads go through
    `nativeSlackGet` against `slack.com/api/*` directly.
  - anything else — a real `NangoConnection` row for slack, read via
    `defaultProxy()` against the same `/conversations.list` /
    `/conversations.history` endpoints the `slack_list_channels` /
    `slack_read_messages` tools use.
  A caller passing a stale or mistyped Nango `connectionId` gets
  `'no-connection'` — there is deliberately NO silent fallback from a bad
  Nango id to the native plane.
- **Cursor semantics.** One `ActivitySourceCursor` row per
  `(organizationId, source, connectionId)`. Shape:
  `{ channels: [{ id, cursor, done }], listed }`. Each page: fetch → persist
  (`createMany({ skipDuplicates: true })`, `backfill: true`, `chainDepth: 0`)
  → **only then** advance the cursor — a crash between fetch and cursor
  advance re-fetches the same page next run and `skipDuplicates` makes that
  free, never a double-count. Hard caps per job:
  `BACKFILL_MAX_EVENTS_PER_JOB` (2000) and `MAX_PAGES_PER_JOB` (500,
  independent — guarantees termination even against a transport bug that
  keeps returning a static cursor).
- **Known limitation — channel-roster staleness.** The channel list
  (`channels`/`listed` in the cursor) is fetched ONCE per cursor's lifetime
  and never re-listed. A channel created in the workspace AFTER that
  snapshot is invisible to backfill until the cursor row is manually reset
  (delete the `ActivitySourceCursor` row for that
  `organizationId`/`source`/`connectionId` and re-run). This is a real,
  disclosed gap — not planned work, just how it behaves today.
- **Error-message wording (native plane, no token).** If the native plane
  has no bot token saved for the org, backfill's error path presently
  reuses `runtime.ts`'s generic "no connection" wording, which reads as if
  no Slack app is connected at all rather than specifically "no token to
  backfill with" — a known cosmetic imprecision, not a functional bug.

## 4. Stale-claim watch

A `claimed` row that never advances to `dispatched`/`throttled`/`failed`
means the process crashed between creating the claim and starting the run —
by design, this is NEVER auto-recovered (retrying would risk a double-fire,
which exactly-once dispatch must never do). It's purely an observability
signal, watched two ways:

- **Passive**: if a redelivery of the same event+flow ever happens to hit
  the claim's unique index again, `dispatchActivityEvent` logs a WARN
  (`found a stale claimed row for this event+flow — a previous dispatch
  likely crashed before starting the run`) — but only IF a redelivery occurs.
- **Proactive**: `countStaleActivityTriggerClaims`
  (`src/lib/queue/queue-watch.ts`) counts every `claimed`-status row older
  than `STALE_CLAIM_MS` (15 minutes, `src/lib/activity/dispatch.ts`) across
  ALL orgs, on every `queue-watch` cron tick
  (`/api/cron/queue-watch`). This is the one that finds a stranded claim
  even when nothing else ever touches its event again.

`STALE_CLAIM_MS` is set well above the outbox's own `CLAIM_TIMEOUT_MS` (10
minutes) so a claim isn't flagged "stranded" while a legitimate redelivery
could still be retrying it.

`strandedActivityClaimsReason(count)` produces the alert text (e.g. "3
activity-dispatch claim(s) stuck in 'claimed' for over 15m — a dispatch
likely crashed before starting the run"), fed through the same
edge-triggered, per-condition-cooldown notifier
(`QUEUE_WATCH_COOLDOWN_MS`, default 1 hour) as consumer-loss and dead-letter
alerts, keyed independently (`stranded-activity-claims` cooldown key) so this
condition alerting doesn't suppress or get suppressed by the other two. It
notifies the platform owner (`PLATFORM_OWNER_EMAILS`).

**What a stranded claim means operationally**: the event+flow pair it names
will NEVER get a run from that claim — the fix (if the event still matters)
is to manually re-drive it, e.g. by re-creating an `OutboxEvent` row for the
same `activityEventId` with a fresh `dedupeKey` (the original row's dedupe
key is already consumed), or by directly calling `dispatchActivityEvent` for
that id — but only after confirming the stranded claim truly never started a
run, since a second dispatch attempt for the SAME event+flow pair will hit
the same unique index and no-op (`duplicate`) rather than retry.

## 5. Connecting Slack

There are two paths, and the first is the default.

**Install Backstory's app (default).** The workspace admin clicks "Add to Slack"
on /settings. Slack mints a bot token for that workspace and
`/api/slack/oauth/callback` stores it; nobody creates an app and nobody handles a
token. This exists because BYO failed operationally — the person who created a
workspace's app leaves, nobody can reach its settings, and the workspace has a
bot it can neither administer nor replace.

The platform side needs `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and
`SLACK_SIGNING_SECRET` set once (see `.env.example`), plus
`https://<host>/api/slack/oauth/callback` in the app's Redirect URLs. Per-workspace
bot tokens are minted by Slack at install; there is no single embeddable bot
token, because `oauth.v2.access` issues a distinct one per install.

Note that installing connects the WORKSPACE, not its people. Each person still
links their own Slack account before they can summon an agent — that is the
fail-closed identity rule, not a bug.

### Summoning agents from Slack

Two things must be true, and they are separate — this is the most common
support question, because with a platform-owned app people reasonably assume
installing it covered everyone:

1. **The workspace is connected** — Add to Slack, or a BYO app with
   `app_mentions:read`, `chat:write` and `chat:write.customize`, and
   `app_mention` subscribed.
2. **The person is linked** — each individual connects their own Slack from
   /integrations. Installing the app connects the WORKSPACE, not its people. An
   unlinked mention runs nothing, spends no tokens, and replies with a link
   prompt; that is the fail-closed identity rule, not a bug.

Addressing: `@Backstory Scout what changed on Acme?` names a teammate;
`@Backstory what changed?` uses the channel's bound teammate (set on the
teammate's panel, or `PUT /api/slack/channel-bindings`); naming nobody in an
unbound channel asks which teammate. A name that matches nothing also asks
rather than falling back to the channel default.

Replies post as the teammate (name + avatar), in-thread, updating a
placeholder. A run that fails updates the same message rather than going
silent. Every post stamps `metadata.event_payload.chainDepth`, which is what
`ACTIVITY_CHAIN_DEPTH_CAP` reads back to stop an agent answering itself.

**Bring your own app (exception).** Everything below still works for a workspace
that wants its own Slack app, and its own signing secret takes precedence over
the platform app's. An operator standing up a brand-new Slack app needs, at
minimum:

1. **Bot token scopes** (OAuth & Permissions → Bot Token Scopes):
   - `chat:write` — required to post as the bot (`slack_post_message`).
     The bot must also be invited to any channel it's expected to post in.
   - `app_mentions:read` — required to receive `@mentions` at all. Without it
     agents are not summonable from Slack.
   - `chat:write.customize` — required to post a reply under the TEAMMATE's own
     name and avatar. Without it every teammate posts as one undifferentiated
     bot.
   - `channels:history` — required for `conversations.history` (backfill's
     Nango-plane reads and the native-plane `nativeSlackGet` reads use the
     same endpoint).
   - `channels:read` — required for `conversations.list` (backfill's channel
     enumeration).
   - (Private-channel coverage, optional: `groups:history` / `groups:read`
     add private channels the bot has been invited to — public-channel scope
     alone only covers `message.channels`.)
2. **Event Subscriptions** (Event Subscriptions → Subscribe to bot events):
   - `message.channels` at minimum — public-channel messages. This is what
     `normalizeSlackEvent` turns into `kind: 'message.posted'` events.
   - **Request URL**: this workspace's own events endpoint —
     `https://<your-deployment-host>/api/slack/events` (the SAME shared
     route every workspace's app points at; `team_id` on each delivery is
     what routes it back to the right organization — see the route's
     file-level doc comment). Slack sends a one-time `url_verification`
     handshake against this URL the moment it's saved; the route only
     accepts that handshake once a signing secret has been saved for at
     least one workspace (see step 4 below) — save the bot token + signing
     secret FIRST, then paste the Request URL into Slack.
3. **Signing secret** (Basic Information → App Credentials → Signing
   Secret): pasted into the "Signing secret" field alongside the bot token
   on Backstory's own credentials UI
   (`POST /api/integrations/credentials/slack`, driven by
   `WorkspaceCredentialsPanel` at `/credentials`). Required the FIRST time a
   workspace connects Slack (the route 400s with `MISSING_SIGNING_SECRET`
   otherwise) — optional on every later rotation of just the bot token
   (the existing signing secret carries forward via `mergeAuthConfig`).
   Stored encrypted under `authConfig.signingSecret`
   (`IntegrationSecret` row, `provider = 'slack'`).
4. **Bot user id capture**: happens automatically, NOT a manual step. When
   the bot token is saved, `verifyCredential('slack', token)` calls Slack's
   `auth.test` (the "who am I" identity endpoint) as part of verification,
   and the SAME response's `team_id`/`user_id` are captured straight into
   `authConfig.teamId` / `authConfig.botUserId` at connect time — this is
   why there is no separate "capture bot id" step or lazy first-event
   fallback. `botUserId` is what makes the bot's own messages `selfOrigin`
   (loop prevention, §2); `teamId` is what routes an inbound `event_callback`
   back to this org (`findSlackWorkspaceByTeamId`). **One Slack workspace
   (`team_id`) can only ever be connected to ONE Backstory organization** —
   a second org attempting to connect the same workspace is rejected
   (`409 SLACK_TEAM_ALREADY_CONNECTED`) with an audit row recorded either
   way, because an ambiguous `team_id` would silently misroute every future
   event to whichever org's row a lookup happened to return first.

Once all four are in place: build a flow with a `slack` (or `activity`,
`source: 'slack'`) trigger in the builder, publish it, and post a message in
a subscribed channel.

## 6. Entitlement arming rules

Event triggers (`activity` and `slack` trigger types) are **configurable by
anyone**, but only **ARMED** (able to actually fire) for orgs above the free
tier. There are TWO layers to this now — write-time admission (permissive)
and dispatch-time enforcement (the actual gate):

- `canArmEventTriggers(org)` (`src/lib/usage/free-tier-limits.ts`):
  `org.plan !== 'TRIAL'`, OR `org.kind` is `internal` or `partner`
  (`EVENT_TRIGGER_EXEMPT_ORG_KINDS`) — internal/partner orgs are exempt from
  the plan check entirely. One function, two call sites.
- **Write-time (`POST /api/flows/[id]/publish` only, and only there)**:
  `validateFlowGraph(..., { eventTriggerEntitled: canArmEventTriggers(org) })`
  — a TRIAL-plan org (not internal/partner) attempting to PUBLISH a flow
  with an `activity`/`slack` trigger gets a 400
  (`EVENT_TRIGGER_ENTITLEMENT_MESSAGE`: "Event triggers are available on
  paid workspaces."). This is the only one of the five
  `activityMatchColumns()` call sites (§1) that ever checked entitlement —
  `PUT /api/flows`, `PUT /api/v1/flows/[id]`, `POST /api/flows/import`, and
  template instantiation all sync `activitySource`/`activityKinds` on an
  edit with NO entitlement check, by design (an edit must never be blocked
  mid-flow by a plan check). This meant a free-tier org could publish a
  harmless manual-trigger flow, then edit the trigger to `slack`/`activity`
  afterward and have it silently arm — the write path alone could never have
  closed that without becoming needlessly restrictive.
- **Dispatch-time (`dispatchActivityEvent`, `src/lib/activity/dispatch.ts`)
  — the actual enforcement point.** Before the flow scan, for every event,
  one indexed read (`organization.findUnique({ select: { plan, kind } })`)
  re-checks `canArmEventTriggers` against the event's OWN organization. An
  un-entitled org's event is dropped right there (`{ skipped: 'not-entitled'
  }`, WARN-logged) regardless of how "armed" any flow's match columns look —
  this is what actually closes the write-time bypass above, and it is also
  what makes a plan DOWNGRADE take effect immediately: an org that drops
  back to TRIAL after publishing an event-triggered flow stops it from
  firing on the very next event, not "whenever it's next unpublished or
  edited." The write-time check in publish stays exactly as permissive as
  before — it's a first-line UX rejection (fail fast with a clear message at
  the moment of publishing), not the security boundary; dispatch is.

## Appendix: constants at a glance

| Constant | Value | File |
|---|---|---|
| `ACTIVITY_RUNS_PER_FLOW_PER_HOUR` (default via `activityRunsPerFlowPerHour()`) | 60, env-overridable | `src/lib/activity/dispatch.ts` |
| `ACTIVITY_CHAIN_DEPTH_CAP` | 3 | `src/lib/activity/dispatch.ts` |
| `STALE_CLAIM_MS` | 15 min | `src/lib/activity/dispatch.ts` |
| `CLAIM_TIMEOUT_MS` (outbox stale-lock) | 10 min | `src/lib/outbox.ts` |
| `MAX_ATTEMPTS` (outbox) | 8 | `src/lib/outbox.ts` |
| `MAX_FLOWS_PER_EVENT` | 200 | `src/lib/activity/dispatch.ts` |
| `BACKFILL_MAX_EVENTS_PER_JOB` | 2000 | `src/lib/activity/backfill.ts` |
| `MAX_PAGES_PER_JOB` (backfill) | 500 | `src/lib/activity/backfill.ts` |
| `INDEXER_SWEEP_BATCH_SIZE` | 200 | `src/lib/activity/indexer-sweep.ts` |
| `QUEUE_WATCH_COOLDOWN_MS` | 1 hour, env-overridable | `src/lib/queue/queue-watch.ts` |

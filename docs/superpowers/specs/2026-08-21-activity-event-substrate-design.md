# Activity Event Substrate + activity/slack Flow Triggers — Design

Date: 2026-08-21
Status: approved for autonomous execution (continuous-execution workflow)
Origin: Sublime parity sweep item 1 (flows-gumloop-parity roadmap); Gumloop app-triggers equivalent.

## Goal

Provider activity (Slack messages, Salesforce changes, GitHub events) becomes a
first-class, persisted, normalized event stream that can trigger flows exactly once
per (event, flow), with cursor-checkpointed backfills, graph-RAG indexing, and two
new flow trigger types: `activity` (any connected app, filtered) and `slack`
(Slack-specific, thread-aware). Today provider events are either dropped with a WARN
(no Nango mirror row), or forwarded as signals with `dedupeKey: null` — the same
event can fire a flow twice, and nothing is persisted or queryable.

## Architecture (four layers)

### 1. Ingestion → `ActivityEvent`

New model `ActivityEvent` (placed near `Signal` in schema.prisma):
`organizationId`, `source` (`slack|salesforce|github|nango:<provider>`),
`sourceEventId`, `kind` (normalized verb, e.g. `message.posted`, `record.updated`,
`pr.opened`), `occurredAt`, `actorExternalId`, `ownerUserId` (nullable — the rep
whose connection ingested it), `visibility` (`org|private`, mirroring the graph
store's model), subject refs (`channelId`, `threadTs`, `recordId`, `repo` folded
into a typed `subject` Json), `payload` Json (capped, truncation-marked),
`indexedAt DateTime?`, `createdAt`.
`@@unique([organizationId, source, sourceEventId])` — duplicate deliveries are
acks, not new rows (P2002 = duplicate, same as `Signal`).

Writers:
- **Slack Events API receiver** (new `/api/slack/events`): signing-secret
  verification, `url_verification` challenge, `event_callback` normalization,
  Slack retry-header tolerance (retries dedupe on `event_id`). Credential is the
  per-workspace Slack secret; the env-token fallback stays internal-only and the
  customer edition surfaces "connect Slack to enable" instead.
- **Nango forward/sync normalizers**: replace the drop-WARN at
  `nango/webhook/route.ts:116` — provider events with or without a mirror row
  persist an `ActivityEvent` (mirror-less events land with `ownerUserId: null`,
  org-resolved via the connection sync path, or are quarantined with a persisted
  reason — never silently acked). Normalizers for salesforce and github payload
  shapes follow `mapEventToSignal`'s defensive-extraction style; `sourceEventId`
  falls back to `sha256:` of type+payload exactly as signals do.

RLS + tenant-guard registration + retention sweep (90d, with graph-parity pruning
of `activity:` nodes) ship in the same migrations as each model.

### 2. Exactly-once dispatch → `ActivityTriggerClaim`

New model `ActivityTriggerClaim`: `@@unique([organizationId, activityEventId,
flowId])`. The dispatcher claims (create; P2002 = already fired) **then**
dispatches via `dispatchFlowExecution` — the flow-side twin of
`AgentExecution.idempotencyKey` in `signals/router.ts`. Claim rows carry the
resulting `flowRunId` once known, and terminal status for observability.

Matching is an **indexed query over trigger shape**, not load-N-flows-and-filter:
active flows with `trigger.type in ('activity','slack')` are mirrored into a small
match table (or indexed columns on Flow) keyed by `(organizationId, source, kind)`
with optional channel/actor filters evaluated per event. The signal plane's
200-flow JS filter is the anti-pattern to avoid.

Event runs reuse the existing owner ladder verbatim (flow owner → oldest active
member, WARN+skip when none) and key their `FlowSideEffect` scope by the event id
(`${flowId}:${activityEventId}`) so replays replay.

### 3. Cursors + backfill

New model `ActivitySourceCursor`: `(organizationId, source, connectionId)` →
`cursor` Json + `lastBackfilledAt`. A backfill worker (queue job, same plane as
poll dispatch) pages a source's read API from the stored cursor, normalizes into
`ActivityEvent` (same unique key makes it idempotent), checkpoints the cursor
AFTER persisting the page (at-least-once, mirroring `poll-dispatch.ts`'s
dispatch-then-cursor rationale inverted for ingestion: persist rows, then advance).
Backfills never fire triggers by default (`backfill: true` on the event row;
matcher skips them) — triggers are for live events; backfill feeds the graph.

### 4. Graph-RAG indexing

`rag/store.ts` gains `NodeType 'activity'`, `activity:` id prefix, and an
`about_activity`/`activity_triggered_run` relation; `rag/indexer.ts` gains a
`commitActivity` batch keyed by stable node ids. The **authority for "indexed" is
`ActivityEvent.indexedAt`** (nullable column, indexed by `[organizationId,
indexedAt]`), swept by a periodic indexer job — the graph store stays best-effort
and can be rebuilt from rows. Private-connection events index with
`visibility:'private', ownerUserId` (agents-act-as-user invariant; no cross-rep
leak).

## Trigger types + builder

`FLOW_TRIGGER_TYPES` gains `'activity'` and `'slack'`, plus ALL six duplicated
unions the audit located (route zod enum, execute-flow job type, trigger-editor,
flow-picker, flow-canvas, builtin-catalog). Builder work: catalog leaves, picker
icon/tone entries (also backfill the missing `poll` entries), trigger-editor
panels (source/kind/channel filter pickers as plain-English chips — never raw
event codes, per the no-raw-token mandate), page.tsx seed branch, `validate.ts`
rules ("A Slack trigger needs a connected Slack workspace."), activity-page filter,
node-presentation copy:
- `slack` → "When someone posts in Slack" (channel/thread filters optional)
- `activity` → "When something happens in a connected app"

Slack runs persist `channel` + `threadTs` on the run's trigger context so delivery
steps default to replying in-thread (`slack_post_message` already supports
`thread_ts`).

## Decisions (recorded rulings)

1. **Allowances**: event-triggered runs bypass the per-person daily cap like every
   headless plane, BUT the activity plane adds its own guard: a per-flow rolling
   throttle (default 60 event-runs/hour/flow, constant + env override) and the
   existing org in-flight capacity + token ceiling. Saturation persists a
   `throttled` claim row (visible, not silent). Rationale: neither burning one
   member's 5/day nor an uncapped firehose is acceptable.
2. **Loop guard**: events whose actor is the workspace's own posting identity
   (bot user id captured at connect time) are marked `selfOrigin: true` and never
   match triggers; plus an event-chain depth cap analogous to `SIGNAL_DEPTH_CAP`
   carried in the run's trigger context (a flow run started by an activity event
   stamps depth; Slack posts made by flows include metadata enabling the receiver
   to stamp `chainDepth`, suppressed at 3).
3. **Free-tier**: event triggers are configurable by anyone but ARM only for
   workspaces above free tier or internal/partner (entitlement check at publish
   validation, plain-English message). Keeps the abuse surface off the 5-runs/day
   tier without per-person cap distortions.

## Out of scope (this workstream)

Sublime items 2+ (Slack agent surface/thread sessions beyond run binding,
flows-as-tools, Flow Jam, node-type router, remediation, run chat, collaborators,
invitations, Pipedream). Socket mode. Slash commands/interactivity payloads.
DOCX/audio anything. Per-step API keys.

## Acceptance

- A Slack message in a connected workspace fires a matching published flow exactly
  once, replies land in-thread, and a replayed/duplicate delivery does not re-fire.
- A Nango salesforce/github forward persists a queryable ActivityEvent even when
  no mirror row exists (nothing is silently dropped).
- Backfill pages history idempotently from a stored cursor and never fires triggers.
- Events appear in the graph with correct visibility; `indexedAt` is the authority.
- Self-origin and depth-capped events never match; per-flow throttle saturates
  visibly.
- All six trigger-union sites updated; builder copy is plain-English; RLS coverage
  test passes for every new model; retention sweeps rows + graph nodes in parity.
- Gates: tsc, lint, unit, CI-mode DB suite; migrations via `prisma migrate deploy`;
  Fly worker redeploy flagged (new queue jobs).

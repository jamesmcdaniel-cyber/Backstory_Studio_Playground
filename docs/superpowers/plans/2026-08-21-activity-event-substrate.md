# Activity Event Substrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provider activity (Slack/Salesforce/GitHub) becomes a persisted, normalized, exactly-once flow-trigger plane with cursor-checkpointed backfill and graph-RAG indexing, plus `activity` and `slack` trigger types in the builder.

**Architecture:** Four layers per the spec — ingestion (`ActivityEvent` rows from a new Slack Events receiver + Nango normalizers), exactly-once dispatch (`ActivityTriggerClaim` claim-then-dispatch through `dispatchFlowExecution`), cursors/backfill (`ActivitySourceCursor` + queue job), and graph indexing (`indexedAt` as authority). The 2026-08-21 exploration map (spec appendix references) locates every seam; the audit's six duplicated trigger-type unions are the blast radius for the new types.

**Tech Stack:** Next.js App Router, Prisma/Postgres (RLS per-table), BullMQ (Fly worker), Nango, Slack Events API, existing rag/ store adapters.

**Spec:** `docs/superpowers/specs/2026-08-21-activity-event-substrate-design.md`

## Global Constraints

- Every new org-scoped model: `organizationId @db.Uuid` + cascade relation, registered in `ORG_SCOPED_MODELS` (src/lib/tenant-guard.ts), **RLS policy + FORCE + backstory_app GRANT in the same migration** (template: `prisma/migrations/20260818130000_rls_teams_grants_idps_tokens/migration.sql`); `rls-coverage.db.test.ts` must pass.
- Migrations named `YYYYMMDDHHMMSS_snake_case`, deploy path `prisma migrate deploy` (baselined) — never `db push`. Local verify against `postgresql://postgres@localhost:5432/bs_ci_repro` + `prisma migrate diff` no-drift.
- No Supabase vars locally: `npx tsc --noEmit`, lint, unit tests; DB-gated via bs_ci_repro. Never `next build`. Test files <45KB; DB tests use delta/seeded-scope assertions (shared-DB residue; see costs-route.db.test.ts advisory-lock pattern).
- Peers commit concurrently: `git status` first, stage ONLY your task's files, commit direct to main (controller pushes), `feat(activity):`/`fix(activity):` messages ending "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>".
- Plain-English UI copy, never raw event codes ([[no-raw-token-syntax]] mandate). Customer edition: no env-token Slack fallback exposure; entitlement-gated arming per spec ruling 3.
- Cross-tenant reads (org-less webhook resolution) use `systemPrisma` with a justification comment (house pattern).
- `truncateWithMarker` (src/lib/flows/truncate.ts) for all payload caps. Cost/token accounting flows through the existing ledger; no new counters.
- The worker runtime (src/lib/workers/runtime.ts) gains new queues in this plan — final report must flag **Fly worker redeploy**.

---

### Task 1: Schema trio + RLS + retention

**Files:** Modify `prisma/schema.prisma` (add `ActivityEvent` near Signal ~:836; `ActivityTriggerClaim` near FlowWebhookReceipt ~:1590; `ActivitySourceCursor` near NangoConnection ~:1189); Create migration `<ts>_activity_event_substrate/migration.sql` (tables + indexes + RLS×3 + GRANTs); Modify `src/lib/tenant-guard.ts` (ORG_SCOPED_MODELS), `src/app/api/cron/retention/route.ts` (90d sweep for ActivityEvent + terminal claims, counters in log line AND JSON response, graph `activity:` prune parity stub calling the store's deleteByIds like `run:`/`signal:` do).

**Interfaces — Produces (later tasks consume these exact shapes):**
```prisma
model ActivityEvent {
  id             String    @id @default(uuid()) @db.Uuid
  organizationId String    @db.Uuid
  source         String    // 'slack' | 'salesforce' | 'github' | 'nango:<provider>'
  sourceEventId  String
  kind           String    // normalized verb: 'message.posted' | 'record.updated' | 'pr.opened' | ...
  occurredAt     DateTime
  actorExternalId String?
  ownerUserId    String?   @db.Uuid
  visibility     String    @default("org") // 'org' | 'private'
  selfOrigin     Boolean   @default(false)
  backfill       Boolean   @default(false)
  chainDepth     Int       @default(0)
  subject        Json?     // { channelId?, threadTs?, recordId?, repo?, ... }
  payload        Json
  indexedAt      DateTime?
  createdAt      DateTime  @default(now())
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  @@unique([organizationId, source, sourceEventId])
  @@index([organizationId, indexedAt])
  @@index([organizationId, source, kind, createdAt])
  @@map("activity_events")
}
model ActivityTriggerClaim {
  id              String   @id @default(uuid()) @db.Uuid
  organizationId  String   @db.Uuid
  activityEventId String   @db.Uuid
  flowId          String   @db.Uuid
  status          String   @default("claimed") // 'claimed'|'dispatched'|'throttled'|'failed'
  flowRunId       String?  @db.Uuid
  createdAt       DateTime @default(now())
  organization    Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  @@unique([organizationId, activityEventId, flowId])
  @@index([organizationId, flowId, createdAt])
  @@map("activity_trigger_claims")
}
model ActivitySourceCursor {
  id              String    @id @default(uuid()) @db.Uuid
  organizationId  String    @db.Uuid
  source          String
  connectionId    String
  cursor          Json
  lastBackfilledAt DateTime?
  organization    Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  @@unique([organizationId, source, connectionId])
  @@map("activity_source_cursors")
}
```

- [ ] **Step 1:** Failing test: extend rls-coverage expectations (it auto-discovers org-scoped models — run it, confirm it fails for the three new tables before the migration's RLS block exists in the DB). Plus a retention DB test seeding a 91-day-old ActivityEvent and asserting the sweep removes it and reports the counter.
- [ ] **Step 2:** Verify fail. **Step 3:** Implement schema + migration + guard registration + retention. Apply to bs_ci_repro; `prisma migrate diff` no-drift. **Step 4:** rls-coverage + retention tests green; tsc. **Step 5:** Commit `feat(activity): ActivityEvent substrate schema — events, claims, cursors, RLS, retention`.

### Task 2: Normalization core

**Files:** Create `src/lib/activity/normalize.ts` + `src/lib/activity/__tests__/normalize.test.ts`.

**Interfaces — Produces:** `normalizeSlackEvent(orgId, envelope) → NormalizedActivity | null`, `normalizeNangoForward(orgId, provider, payload) → NormalizedActivity | null` (salesforce + github specific shapes, generic fallback), where `NormalizedActivity = { source, sourceEventId, kind, occurredAt, actorExternalId, ownerUserId, subject, payload, selfOrigin, chainDepth }`. `sourceEventId` falls back to `sha256:`-prefixed hash of type+payload (mapEventToSignal precedent, src/lib/signals/map.ts:57). Payload capped at 50k chars via `truncateWithMarker`. Pure functions, no I/O.

- [ ] **Step 1:** Failing tests: slack message event → `message.posted` with channel/threadTs subject; slack bot-authored (bot_id/own bot user) → `selfOrigin: true`; nango salesforce record change → `record.updated` with recordId; github PR payload → `pr.opened`; unknown shape → generic kind with hash id; oversize payload carries marker; missing event id → `sha256:` fallback.
- [ ] **Step 2:** Verify fail. **Step 3:** Implement (defensive multi-key extraction per map.ts style). **Step 4:** Green + tsc. **Step 5:** Commit `feat(activity): pure normalizers for slack, salesforce, github, and generic provider events`.

### Task 3: Nango ingestion — nothing silently dropped

**Files:** Modify `src/app/api/nango/webhook/route.ts` (~:111–122 region), `src/lib/outbox.ts` (`providerSignalOutboxEvent` dedupeKey ~:85). Test: extend the route's existing test file (or create sibling) DB-gated.

**Interfaces — Consumes:** Task 2 normalizers; Task 1 models. **Produces:** every `sync`/`forward` delivery persists an ActivityEvent (P2002 → duplicate ack); mirror-less events resolve org via `nangoConnection` sync fallback or persist to a quarantine log row (an ActivityEvent under the resolvable org with `kind:'unresolved.connection'` is acceptable if org IS resolvable; if org is NOT resolvable, keep the WARN but include the connectionId — document that this is the only remaining drop and why). Outbox `dedupeKey` becomes `activity:${source}:${sourceEventId}` (replacing null).

- [ ] **Step 1:** Failing DB tests: forward event persists row; duplicate delivery is acked without a second row; outbox row carries the real dedupeKey; mirror-less-but-org-resolvable event persists. **Step 2:** Verify fail. **Step 3:** Implement. **Step 4:** Green + tsc + existing nango webhook tests still green. **Step 5:** Commit `feat(activity): nango provider events persist as ActivityEvents — the drop-WARN path is closed`.

### Task 4: Slack Events API receiver

**Files:** Create `src/app/api/slack/events/route.ts`, `src/lib/activity/slack-verify.ts`; Modify the Slack connect path to capture the workspace's bot user id (find where Slack credentials/connections are stored — IntegrationSecret provider 'slack' and/or nango slack connection metadata; store `botUserId` alongside). Tests: signing verification unit tests + route DB test.

**Interfaces — Consumes:** Task 2 `normalizeSlackEvent`. **Produces:** POST handler: (1) raw-body HMAC-SHA256 signing-secret verification with 5-minute timestamp window (secret from per-workspace credential; env fallback internal-only per edition rules); (2) `url_verification` → echo challenge; (3) `event_callback` → normalize → persist (P2002 ack) → hand event id to the Task 6 dispatcher via the outbox topic `activity.dispatch` (durable, not inline); (4) Slack retry headers (`x-slack-retry-num`) tolerated — dedupe makes retries acks; (5) events from the workspace's own `botUserId` marked selfOrigin at normalize time. Respond 200 within Slack's 3s budget — never do matching inline.

- [ ] **Step 1:** Failing tests: bad signature 401; stale timestamp 401; challenge echoed; message event persists + outbox row; retry delivery acks without new row; bot-self event persists with selfOrigin. **Step 2:** Verify fail. **Step 3:** Implement. **Step 4:** Green + tsc. **Step 5:** Commit `feat(activity): Slack Events API receiver — verified, deduped, durable handoff`.

### Task 5: Trigger types across all unions + validation + entitlement arming

**Files:** Modify `src/lib/flows/trigger.ts` (FLOW_TRIGGER_TYPES + labels + normalize + triggerInputFields), `src/app/api/flows/route.ts:24` (zod), `src/features/flows/execute-flow.ts:91` (job type), `src/components/flows/trigger-editor.tsx`, `src/components/flows/flow-picker.tsx`, `src/components/flows/flow-canvas.tsx`, `src/lib/flows/builtin-catalog.ts`, `src/lib/flows/validate.ts:184+` (rules: activity needs source+kind filter; slack needs a connected Slack workspace; both need entitlement to ARM — publish-time check with plain-English message per spec ruling 3), `src/lib/flows/node-presentation.ts` (copy). Trigger config shape: `{ type:'activity', source, kinds: string[], filters?: {channelId?, actorExternalId?} }` / `{ type:'slack', channelId?, threadOnly?: boolean }`.

- [ ] **Step 1:** Failing tests: normalizeFlowTrigger round-trips both new types; validate.ts rejects an armed activity trigger without source/kind and a slack trigger without a Slack connection, accepts valid ones; zod enum accepts the new types. **Step 2:** Verify fail. **Step 3:** Implement across ALL six union sites (grep to confirm none missed; also backfill the missing `poll` icon/tone entries in flow-picker noted by the audit). **Step 4:** Green + tsc + lint. **Step 5:** Commit `feat(activity): activity and slack trigger types across every union, with plain-English validation`.

### Task 6: Matcher + exactly-once dispatch + guards

**Files:** Create `src/lib/activity/dispatch.ts` + tests; Modify `prisma/schema.prisma` + migration `<ts>_flow_activity_match_columns/`: `Flow` gains nullable indexed `activitySource String?` + `activityKinds String[]` (synced from trigger on save/publish exactly where `triggerFromGraph` syncs `Flow.trigger` — find that write path and extend it), `@@index([organizationId, activitySource])`; Modify `src/lib/outbox.ts` deliver switch: new topic `activity.dispatch` → `dispatchActivityEvent(eventId)`.

**Interfaces — Consumes:** Tasks 1, 3, 4, 5. **Produces:** `dispatchActivityEvent(activityEventId)`: loads event; skips `selfOrigin`, `backfill`, `chainDepth >= 3`; indexed query for ACTIVE published flows matching `(organizationId, activitySource, kind ∈ activityKinds)` + per-event filter predicate (channel/actor) + `triggerConditionPasses`; per flow: rolling per-flow throttle (count claims in last hour < `ACTIVITY_RUNS_PER_FLOW_PER_HOUR` = 60, env-overridable) → saturated flows get a `status:'throttled'` claim row; otherwise CREATE claim (P2002 → skip, exactly-once), resolve owner via the standard ladder (flow.userId active else oldest active member, WARN+skip), then `dispatchFlowExecution` with `trigger: { type: 'activity'|'slack', ... }` carrying event id + subject (channel/threadTs) + chainDepth, side-effect scope keyed `${flowId}:${activityEventId}`; update claim `dispatched` + flowRunId (or `failed`).

- [ ] **Step 1:** Failing DB tests: matching flow fires once, duplicate dispatch call fires zero (claim P2002); selfOrigin/backfill/depth-3 events fire nothing; throttle: 60 claims seeded in the hour → 61st is `throttled` with no run; non-matching kind fires nothing; owner ladder WARN+skip when org has no active members. **Step 2:** Verify fail. **Step 3:** Implement + match-column sync + outbox topic. **Step 4:** Green + tsc + CI-mode. **Step 5:** Commit `feat(activity): exactly-once activity dispatch — indexed matching, claims, throttle, loop guards`.

### Task 7: Cursors + backfill worker

**Files:** Create `src/lib/activity/backfill.ts` + tests; Modify `src/lib/workers/runtime.ts` + queue definitions (new queue `activity-backfill`, follow the model-bench queue's registration shape), an admin-triggerable POST route on an EXISTING admin surface pattern (mirror how bench is enqueued from /api/admin/models/bench — no new page; the route slots under /api/admin/).

**Interfaces — Consumes:** Tasks 1–2; Slack read via the existing nango `slack_read_messages`/`slack_list_channels` tool wire (src/lib/nango/provider-tools.ts) or the underlying fetch those tools use — reuse the transport, not the agent tool layer. **Produces:** `runActivityBackfill(orgId, source, connectionId)`: read page from stored cursor → normalize → persist batch (`backfill: true`, unique key = idempotent) → advance cursor AFTER persist → repeat until page empty or `BACKFILL_MAX_EVENTS_PER_JOB` (2000). GitHub/Salesforce backfill ships only if an equivalent read transport already exists — otherwise Slack-only with the others stubbed behind the same interface and a report note (do NOT build new provider API clients in this task).

- [ ] **Step 1:** Failing tests: mocked-transport backfill persists page, advances cursor after persist (crash between persist and advance re-ingests idempotently — assert re-run yields no duplicate rows), respects cap, marks `backfill: true`, fires no dispatch. **Step 2:** Verify fail. **Step 3:** Implement + queue + admin trigger route. **Step 4:** Green + tsc + CI-mode. **Step 5:** Commit `feat(activity): cursor-checkpointed backfill worker — idempotent, trigger-silent`.

### Task 8: Graph-RAG indexing + indexedAt sweeper

**Files:** Modify `src/lib/rag/store.ts` (NodeType `'activity'`, `activity:` prefix convention, EdgeRelation `about_activity` + `activity_triggered_run`), `src/lib/rag/indexer.ts` (`commitActivity(events)` batch), Create `src/lib/activity/indexer-sweep.ts` + cron wiring (find the existing cron route family; a sweep endpoint that indexes `indexedAt IS NULL` rows in batches of 200, stamps `indexedAt` AFTER successful commit), Modify retention graph-parity prune (Task 1 stub → real `activity:` deletion).

**Interfaces — Consumes:** Task 1 `indexedAt` authority semantics; existing `commitGraph`/visibility model. Private-connection events (`visibility:'private'`) index with `ownerUserId`; org events shared.

- [ ] **Step 1:** Failing tests (memory-store adapter): commitActivity upserts `activity:` nodes with correct visibility + edges to account/opportunity when subject refs resolve; sweep stamps indexedAt only on success; ragEnabled()=false leaves rows unstamped (never lies). **Step 2:** Verify fail. **Step 3:** Implement. **Step 4:** Green + tsc. **Step 5:** Commit `feat(activity): activity events index into the graph — indexedAt is the authority`.

### Task 9: Builder UI + run thread-binding

**Files:** Modify `src/lib/flows/builtin-catalog.ts` (TRIGGER_LEAVES + fix the stale "four ways" comment), `src/components/flows/flow-picker.tsx` (rows, TRIGGER_ICON/TONE incl. poll backfill), `src/components/flows/trigger-editor.tsx` (panels: activity = source picker + plain-English kind chips + optional channel/actor filters; slack = workspace check + optional channel + "only thread replies" toggle), `src/app/flows/[id]/page.tsx` (~2710 seed branch), `src/app/flows/[id]/activity/page.tsx` (trigger filter), `src/lib/flows/node-presentation.ts` (titles/subtitles: "When someone posts in Slack" / "When something happens in a connected app"); Modify `src/features/flows/execute-flow.ts`: slack-triggered runs persist `channel`+`threadTs` in the run's trigger context and the nango `slack_post_message` delivery path defaults `thread_ts` to the trigger's threadTs when the step doesn't set one.

- [ ] **Step 1:** Failing tests: trigger-editor renders both panels with plain-English copy (component test per repo convention); delivery threading unit test (trigger context threadTs flows to slack_post_message default). **Step 2:** Verify fail. **Step 3:** Implement. **Step 4:** Green + tsc + lint (jsx-a11y). **Step 5:** Commit `feat(activity): builder trigger surfaces and in-thread Slack replies`.

### Task 10: End-to-end proof + runbook

**Files:** Create `src/lib/activity/__tests__/activity-e2e.db.test.ts` (seeded-org-scoped, delta assertions); Create `docs/runbooks/activity-plane.md` (ingestion → claim → run trace path, throttle/loop-guard semantics, backfill ops, Slack app manifest requirements: event subscriptions + signing secret + bot user id, entitlement arming); Modify `docs/flows-n8n-parity-audit.md` or the roadmap doc ONLY if it exists with a natural slot (do not create new parity docs).

- [ ] **Step 1:** Failing e2e DB test: signed Slack message POST → ActivityEvent → outbox drain → claim → FlowRun exists with thread context; same POST replayed → no second run; bot-self message → no run; 500-event burst on one flow → ≤60 runs + throttled claims visible. **Step 2:** Verify fail. **Step 3:** Implement test + runbook. **Step 4:** Green + full CI-mode suite + tsc + lint. **Step 5:** Commit `feat(activity): end-to-end proof and operations runbook`.

---

## Final gate (after Task 10)

- [ ] Full suite (0 fail — the gate is genuinely green now; keep it), tsc, lint, CI-mode repro.
- [ ] `git status` re-check, push to main.
- [ ] Report: migrations added (deploy via next Vercel deploy), **Fly worker redeploy required** (new queue), Slack app manifest/env steps the user must do (signing secret, event subscription URL, bot user id capture on connect).

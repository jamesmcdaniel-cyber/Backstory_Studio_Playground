# Infrastructure audit — scaling to 100+ concurrent users

Date: 2026-07-31 · Scope: multi-tenancy isolation, per-person/per-org state, capacity
Method: static read of the repo at `95a0c7d`. **No load test was run**, and production
env values (Vercel/Render) were not inspected — items marked **[verify]** need a
console check before they can be called confirmed or clear.

---

## Verdict

The tenancy *model* is stronger than most products at this stage: a runtime tenant
guard on the Prisma client, a real permission registry, org-scoped composite indexes,
per-org webhook secrets, and a route-smoke regression net for unscoped queries. Under
100 concurrent users the **read path will hold**.

Three axes will not:

1. **Scheduled work starves platform-wide.** The cron scheduler does an unordered,
   globally-capped scan. Past ~200 active agents, an arbitrary and stable subset of
   orgs simply stops firing — silently.
2. **One worker instance is the entire execution plane.** ~5–20 concurrent job slots,
   no per-org fairness, no autoscaling. One org can occupy all of it.
3. **Identity and settings state is cached per-instance and stamped per-org in ways
   that go stale or cross boundaries.** This is the direct cause of the "settings
   remembered for the wrong person/org" symptom, and it opens a real up-to-60-second
   window where a removed or moved user still acts inside their old workspace.

There is **no Postgres row-level security** anywhere (`supabase/` contains only
Realtime-channel RLS for the flow jam). The tenant guard is a guardrail with
documented holes, and it is the only structural barrier between orgs.

---

## P0 — Cross-tenant / wrong-identity correctness

### 1. Auth-row cache is per-instance; invalidation is local-only

`src/lib/supabase/auth-utils.ts:18-36`

`dbUserCache` is a module-level `Map` with a 60s TTL holding the user row **and its
organization**. `invalidateAuthCache()` deletes from the map on *the one instance that
ran it*. On Vercel there are N warm lambdas; on Render there is a separate worker
process. Every other instance keeps serving the stale org/role for up to 60s.

Worse, two mutations never invalidate at all:

- `src/app/api/organizations/members/[id]/route.ts:52` — role change (PATCH)
- `src/app/api/organizations/members/[id]/route.ts:70` — member removal (DELETE, soft
  `isActive: false`)

A demoted admin keeps `members.manage`, `org.manage`, and `audit.read` for up to 60s.
A removed member keeps full workspace access for up to 60s, on every warm instance.

**Fix.** Move the cache to the shared backend already wired up in `src/lib/cache.ts`
(Upstash REST), keyed `auth:<supabaseId>`, and `cacheDelete` on every membership /
role / org mutation. Or keep it local but drop the TTL to ~5s and gate on a per-user
version stamp read from Redis. Add invalidation to the two member routes either way.

### 2. Moving orgs leaves per-user settings stamped with the old org

`src/app/api/invitations/accept/route.ts:28-38`

Accepting an invite reassigns `user.organizationId` and updates the invitation. Nothing
else. Every row that carries **both** `userId` and `organizationId` keeps pointing at
the old workspace:

| Model | Constraint | Consequence after an org move |
|---|---|---|
| `Integration` | `@@unique([userId, provider])` — *not org-scoped* (`prisma/schema.prisma:573`) | The user **cannot reconnect the same provider** in the new org; the old row still surfaces via the old org's `@@index([organizationId, provider])` |
| `McpConnection` | `@@unique([organizationId, userId, provider])` (`:625`) | Backstory MCP gate re-triggers; a duplicate row is seeded in the new org |
| `PeopleAiConnection` | `@@unique([organizationId, userId])` (`:598`) | Sales AI connection is orphaned in the old org |
| `PushSubscription`, `AgentChatSession` | org + user | Notifications and chat history attributed to a workspace the user left |

This is precisely the reported symptom. It also means the *old* org retains rows
attributed to a person who is no longer a member.

**Fix.** A `transferUserToOrganization(userId, orgId)` that, in one transaction,
re-homes or revokes each per-user row. Change `Integration` to
`@@unique([organizationId, userId, provider])`. Backfill existing mismatches
(`Integration.organizationId != user.organizationId`) with a migration script.

### 3. Built-in tool credentials are single global env vars

`src/lib/integrations/slack.ts:21,61` · `email.ts:40,97` · `granola.ts:54`

Slack and Resend are keyed to `SLACK_BOT_TOKEN` / `RESEND_API_KEY` with no per-org
override. Granola takes a per-org `IntegrationSecret` but falls back to the global
`GRANOLA_API_KEY`. Every workspace's agents therefore post into **the same Slack
workspace** and send mail from **the same account**. Org A's agent can read and write
org B's channels.

ARCHITECTURE.md already lists this as tech debt ("acceptable single-tenant, blocking
for multi-tenant"). At 100+ users across orgs it is a live cross-org data flow, not
debt. The `Integration` / `IntegrationSecret` tables already exist to hold these.

### 4. Browser caches survive sign-out and are not namespaced by user

`src/lib/client/snapshot.ts:41` (`bs:snapshot`, 24h) ·
`src/lib/client/use-cached-json.ts:30` (`bs:swr:<url>`, 24h) ·
`src/components/providers/supabase-provider.tsx:130`

`signOut()` calls `supabase.auth.signOut()` and nothing else. The previous user's
agents, notifications, org name, and usage remain in `localStorage` under keys with no
user or org component, and paint immediately on the next sign-in before revalidation.
Shared machines and account switches both expose it.

**Fix.** Clear both prefixes in `signOut()`, and namespace the keys by `supabaseId`.

### 5. The tenant guard has known holes and there is no RLS behind it

`src/lib/tenant-guard.ts:19-25` documents them honestly: an `organizationId` anywhere
in the `where` tree satisfies the check (including a bare `OR` branch or
`NOT: { organizationId }`), nested writes through a parent are invisible to the
extension, and `$queryRaw`/`$executeRaw` are unguarded.

Transitively-scoped children are excluded entirely. E.g.
`src/app/api/workflows/executions/route.ts:31` runs
`workflowStep.findMany({ where: { executionId: { in: ids } } })` with no org filter —
correct today only because `ids` came from a scoped query one statement earlier. That
is one refactor away from a leak, and the guard would not catch it.

Raw SQL was checked individually and **is** correctly org-scoped
(`src/lib/memory/agent-memory.ts:69`, `src/lib/knowledge/retrieve.ts:62`), as are the
Neo4j Cypher queries (`src/lib/rag/neo4j-store.ts`).

**Fix.** Enable Postgres RLS on the org-carrying tables with a
`current_setting('app.organization_id')` policy, and set it per transaction from the
auth context. The guard stays as a fast-fail developer signal.

### 6. `systemPrisma` is used in 13 API routes — 4 are user-facing

68 call sites total. Most are legitimately org-less (cron sweeps, webhook trigger
endpoints, tenant resolution) and carry justification comments. Four are deliberately
cross-tenant on a *session* path and depend entirely on an application-level check:

- `src/app/api/flows/[id]/route.ts:19` and `src/app/api/flows/route.ts:84` — share
  links resolve access beyond the caller's org; `resolveFlowRole`
  (`src/lib/flows/access.ts:41`) is the only boundary. It reads correctly, and failures
  404 without leaking, but it is hand-written authorization over an unguarded query.
- `src/app/api/skills/route.ts:56` and `src/app/api/catalogue/entries/route.ts:35-37` —
  published community slices from other orgs, filtered on `catalogueStatus`/`isActive`.

These are defensible designs, but they are the highest-value targets for a
review-and-test pass, because the guard is off and RLS does not exist.

---

## P0 — Will break at 100 concurrent users (capacity)

### 7. The scheduler scans globally with a hard, unordered cap

`src/app/api/cron/dispatch/route.ts:120,243`

```ts
const agents = await systemPrisma.agentTask.findMany({ where: { status: 'ACTIVE' }, take: 200 })
const flows  = await systemPrisma.flow.findMany({ where: { status: 'ACTIVE' }, take: 100, include: { runs: { take: 1 } } })
```

No `orderBy`, no cursor, no fairness, no saturation signal on the agent path. Postgres
returns an arbitrary — in practice *stable* — 200 rows. Past 200 active agents
platform-wide (trivially reached by 100 users), the agents outside that window **never
fire again**, and nothing logs it. `MAX_AGENTS_PER_TICK = 25` then caps dispatch
further. The flow path at least warns on saturation (`:275`), the agent path does not.

Neither table is indexed for this access pattern: `AgentTask` has
`@@index([organizationId, status])` (leading column mismatch for a global
`status` filter) and `Flow` has no status index at all.

**Fix.** Select only *due* candidates in SQL, ordered by staleness
(`lastExecutedAt ASC NULLS FIRST`), paginated by cursor, with an index on
`(status, lastExecutedAt)`. Enqueue rather than dispatch inline. Emit a metric for
"due but deferred".

### 8. Cron executes agent runs inline inside the HTTP request

`src/app/api/cron/dispatch/route.ts:206` calls `runAgentExecution(...)` directly, in a
serial `for` loop over up to 25 agents, under `maxDuration = 800`. One slow multi-turn
run starves every other due agent in the tick, and the tick itself can be killed
mid-run at the 800s ceiling. There are also per-iteration `user.findFirst` lookups
(`:167,172`) — an N+1 against the same handful of rows.

### 9. A single worker instance is the entire execution plane

`render.yaml` declares one `type: worker`, no `numInstances`, no autoscaling.
`src/lib/workers/runtime.ts:29` starts **four** BullMQ Workers (agent, scheduled-agent,
flow, template-generation) that each take `workerConfig.concurrency`
(`AGENT_WORKER_CONCURRENCY=5`). So ~20 concurrent jobs on one Node process, each doing
multi-turn LLM calls plus DB writes.

There is **no per-org concurrency cap anywhere**. The only ceiling is the monthly token
budget (`src/lib/usage/budget.ts`), which is a spend limit, not a fairness mechanism.
One org firing 50 flows occupies every slot; every other org's runs sit in `pending`
until the reaper marks them failed at `AGENT_RUN_TIMEOUT_MS`.

**Fix.** Horizontal worker scaling (Render `numInstances`, or move to a queue-native
autoscaler), plus a per-org in-flight cap enforced at dequeue — BullMQ group/rate-limit
keys, or a Redis semaphore keyed `runs:<orgId>`.

### 10. Connection-pool sizing is right for Vercel and wrong for the worker **[verify]**

`.env.example:9` prescribes `?pgbouncer=true&connection_limit=1` on the Supabase
transaction pooler. Correct for serverless — one connection per lambda instance. But
`render.yaml` passes `DATABASE_URL` to the worker with `sync: false`, and if it is the
same string, then ~20 concurrent jobs share **one** Prisma connection. Every query
serializes and Prisma's default 10s pool timeout starts throwing `P2024` under load.

The same setting also serializes the six parallel queries in
`src/app/api/snapshot/route.ts:29` — the app shell's hottest path — turning a ~50ms
fan-out into a ~300ms chain, on every poll, for every user.

Interactive transactions add pressure: the pgvector retrieval paths
(`src/lib/knowledge/retrieve.ts:56`, `src/lib/memory/agent-memory.ts:65`) hold a
transaction across two `SET LOCAL` statements plus the vector query.

**Action.** Confirm the actual values in both consoles. The worker needs its own
`DATABASE_URL` with a real pool (`connection_limit=10..20`). On Vercel, either raise to
2–3 or accept serialized fan-out and measure it.

### 11. Neo4j falls back to loading an org's entire graph into Node

`src/lib/rag/neo4j-store.ts:124`

```cypher
MATCH (e:Entity { organizationId: $org }) RETURN e AS node
```

with in-process cosine scoring, used whenever the vector index is unavailable. Silent
OOM path as any org's graph grows. Needs a hard cap and an explicit degraded-mode log.

### 12. `/api/health` is anonymous, unrate-limited, and probes three backends

`src/app/api/health/route.ts:19-22`. `neo4jPing()` (`neo4j-store.ts:28-37`) opens and
closes a **fresh Neo4j driver on every call**. A trivial amplification target and a
source of connection churn under any uptime-monitor cadence.

---

## P1 — Load amplification and unbounded growth

### 13. Rate limiting covers 9 of 107 routes, and defaults to per-instance memory

Only trigger / execute / resume / mcp-discover paths call `rateLimit()`. Every
authenticated CRUD route is unlimited. And `src/lib/ratelimit.ts:139` selects the
in-memory limiter unless `UPSTASH_REDIS_REST_*` or `REDIS_URL` is present — so on
Vercel the effective limit is `limit × instance_count`. **[verify]** that the Upstash
vars are set in the Vercel env; if not, every existing limit is already fictional.

### 14. Poll load

`/api/snapshot` (`src/lib/client/snapshot.ts`) is genuinely good work — it collapsed six
shell endpoints into one with an 8s freshness window and in-flight dedupe. Remaining
hot pollers are per-page and much tighter:

| Surface | Interval | File |
|---|---|---|
| Flow editor run poll | 2s | `src/app/flows/[id]/page.tsx:1366` |
| Agent activity pane | 2s | `src/app/agents/agent-activity-pane.tsx:486` |
| Run panel (running) | 2s | `src/components/flows/run-panel.tsx:147` |
| Flow activity | 5s | `src/app/flows/[id]/activity/page.tsx:194` |
| App shell (snapshot) | 8s effective | `snapshot.ts:37` |

**Correction (verified while implementing Wave 3):** the three 2s pollers are all
already conditional — the flow-builder tick self-stops on a terminal run, the
activity pane needs the row expanded *and* the run active, and the run panel already
has Supabase Realtime layered on. So this load scales with active runs being
watched, not with users holding a page open, and the "~50 req/s" figure below is
wrong. The real defect was that none of them paused for a hidden tab; that is fixed.
Each `/api/snapshot` is still 6 queries including `agentTask` `take: 300` with full
row payloads.

**Fix.** Move run/step progress to Supabase Realtime (already in use for the flow jam)
or SSE; drop the 2s intervals to backoff schedules; trim the snapshot agent payload to
list-view fields.

### 15. Unbounded module-scope state on the long-lived worker

`src/lib/mcp/backstory-connection.ts:56` — `seededMemo` is a `Set` that grows with every
`org:user` pair the process ever touches and is **never evicted**. `readyCache` (`:55`)
checks TTL on read but never prunes. On a serverless instance this is bounded by
lifetime; on the Render worker it is a slow leak.

### 16. `syncOrgNangoConnections` does a live API call plus serial upserts on page view

`src/lib/nango/mirror.ts:28,92` — `listConnections({ limit: 1000 })` then one awaited
`upsert` per connection in a loop, triggered by `GET /api/nango/status`. Subject to
Nango's own rate limits under concurrent load.

### 17. `attempts: 2` with side-effecting agent runs

`src/lib/queue/config.ts` sets `attempts: 2` and `maxStalledCount: 1` with
`lockDuration = AGENT_RUN_TIMEOUT_MS`. The comment argues this is safe because runs
checkpoint per turn and replay completed tool calls as no-ops. That reasoning is sound
but load-bearing — a long lock also means a crashed worker's jobs stay invisible for
the full timeout before stall recovery, which is a real availability cost at scale.

---

## Remediation plan

### Wave 1 — isolation correctness (do first; these are live bugs)

1. **Done.** §1 — the per-instance auth cache is removed, not narrowed. Every field
   it held is an authority field, so no subset was safe to serve stale, and a
   module-level Map cannot be invalidated across instances. `getAuthWithUser` now
   reads the row per request on the `users.supabaseId` unique index.
   `invalidateAuthCache` is gone along with its three call sites.
2. **Done.** §2 — `src/lib/org-transfer.ts` moves a user and, in the same
   transaction, revokes the per-user credential rows stamped with the workspace they
   left (`Integration`, `PeopleAiConnection`, `McpConnection`, `PushSubscription`).
   Revoke rather than re-home: those rows carry credentials, and re-homing an OAuth
   connection would expose the user's connected account to a different set of people.
   `Integration` is re-keyed `@@unique([organizationId, userId, provider])` with a
   backfill migration (`20260731120000_integration_org_scoped_unique`) that deletes
   rows stranded in a workspace their owner no longer belongs to.
3. **Done.** §4 — `src/lib/client/cache-owner.ts` stamps the browser caches with the
   signed-in user and wipes them on any identity change (sign-out, account switch,
   cross-tab sign-out, unclaimed cache). Covers `bs:snapshot`, all `bs:swr:*`, the
   flow clipboard and picker favourites, in memory *and* in localStorage. Device
   layout preferences are deliberately preserved.
4. **Awaiting a decision** — per-org Slack / Resend credentials via `IntegrationSecret`
   (§3). This one changes product behavior: existing orgs would have to connect their
   own Slack and sending domain, so it needs an explicit call on migration strategy
   before it ships. See "Open decision" below.

### Wave 2 — capacity floor (do before inviting 100 users)

5. **Done.** §7 — the scan and the cap are now separate concerns. `scanAll`
   (`src/lib/scheduling/scan.ts`) reads *every* active agent and flow by id cursor,
   so no row is excluded from being examined; the per-tick cap then applies to a
   list sorted stalest-first (`stalestFirst`), so overflow is deferred and rotates
   rather than the same rows winning forever. Dueness could not be pushed into SQL
   — it lives in a JSON `schedule` column and in cron expressions — which is exactly
   why a complete scan is the only sound answer. Indexes `(status, id)` added on
   `agent_tasks` and `flows`. Saturation and the runaway backstop both log.
6. **Done.** §8 — the cron enqueues via `dispatchAgentExecution`
   (`src/features/agents/dispatch.ts`) instead of calling `runAgentExecution` inside
   the request; inline mode (dev/CI) is unchanged. The per-candidate user lookups
   are gone: `resolveRunOwners` (`src/lib/scheduling/owners.ts`) resolves the whole
   tick in two queries, and it now also refuses to attribute a run to a named owner
   who has left the org.
7. **Partly done.** §9 — per-org fairness is in: `OrgCapacity`
   (`src/lib/queue/org-capacity.ts`) reads each workspace's in-flight runs (agents
   and flows share one worker-slot budget) and defers dispatch past
   `ORG_MAX_INFLIGHT_RUNS`, so one org's burst can no longer fill the pool.
   `render.yaml` now declares `numInstances: 3`. **Needs you:** applying the Render
   change, and confirming the plan/instance count against real queue depth.
8. **Needs you.** §10 — `render.yaml` and `.env.example` now document that the worker
   must NOT reuse Vercel's `connection_limit=1` string and should run ~20. The actual
   values are console-side and unverified.
9. **Done, with a caveat.** §13 — the default write budget is enforced in
   `withAuthenticatedApi` itself (240/min per user, `WRITE_RATE_LIMIT_PER_MIN`,
   overridable or opt-out per route), so every mutating route is covered including
   ones not yet written. Reads are deliberately excluded — the shell polls by design.
   **Caveat:** this is only a global ceiling if `UPSTASH_REDIS_REST_*` or `REDIS_URL`
   is set on Vercel; otherwise it is per-instance. Still unverified.

### Wave 3 — structural hardening

10. **Guard hardened; RLS deliberately NOT attempted — see below** (§5). The guard
    now asks the right question: not "does `organizationId` appear somewhere in the
    where tree" but "is every row this query can match constrained to the org". The
    four shapes it used to accept and shouldn't — an unscoped `OR` branch,
    `NOT: { organizationId }`, `organizationId: { not: X }`, and a to-many `some:`
    filter — are all rejected now. Positive to-one relation filters still carry
    scope, which is how the transitively-scoped children are meant to be queried.
    Separately, `raw-sql-org-scoped.test.ts` statically enforces that every
    `$queryRaw`/`$executeRaw` touching rows filters on `organizationId`, closing the
    guard's other documented hole.
11. **Done.** §6 — tightening the guard flagged exactly one production query:
    `GET /api/flows`, whose second `OR` branch (cross-workspace collaborator flows)
    carries no org scope. It is a deliberate cross-tenant read, so it moved to
    `systemPrisma` with the reasoning written down — the same treatment its sibling
    `GET /api/flows/[id]` already had. `list-isolation.db.test.ts` now backs that
    boundary with real cross-org data. The other cross-tenant routes turned out to
    be covered already (`share.db.test.ts`, `skills/visibility.db.test.ts`,
    `flow-templates/scoping.db.test.ts`, `access-roles.test.ts`).
12. **Done, and scoped down — §14 above overstated this.** Re-reading the pollers
    before changing them: all three are already conditional. The flow-builder tick
    self-stops once the run reaches a terminal state, the agent activity pane polls
    only while a row is expanded *and* the run is active, and the run panel already
    layers Supabase Realtime broadcasts on top of its poll. So the 2s load scales
    with **active runs being watched**, not with users holding a page open, and the
    "~50 req/s from 100 users with a flow open" figure in §14 is wrong.
    What was real: none of the three paused for a hidden tab. Browsers throttle
    background timers but never stop them, so a builder abandoned in a background
    tab kept issuing authenticated requests for the life of the run.
    `startVisibleInterval` fixes that and catches up on return; the app-shell
    pollers already behaved this way. An SSE/Realtime rearchitecture is not
    warranted at this load — and on Vercel, SSE holds a function invocation open,
    which is not obviously cheaper than a conditional 2s poll.
13. **Done.** §11 — the Neo4j no-vector-index fallback is capped
    (`NEO4J_FALLBACK_SCAN_CAP`, default 5,000) and logs when it truncates, instead
    of pulling an org's whole embedded graph into process memory. §12 — `/api/health`
    caches its result for 5s and coalesces concurrent misses, so an anonymous caller
    can no longer amplify one request into three backend round-trips (one of which
    opened a fresh Neo4j driver). §15 — `seededMemo` and `readyCache` are bounded.

### On row-level security (§5), and why it is not in this wave

RLS is the right end state and I did not build it, because doing it properly is a
project rather than a task, and a half-applied RLS is worse than none — it produces
confident-looking policies with silent gaps.

The specific obstacle is this stack. RLS needs a per-transaction
`SET LOCAL app.organization_id`, and behind a pgbouncer **transaction** pooler a
connection is only yours for the length of a transaction. Prisma issues most
queries outside explicit transactions, so the setting would either leak to the next
borrower of that pooled connection or be lost before the query runs. Making it
correct means wrapping *every* model operation in an interactive transaction — two
extra round-trips each, holding a pooled connection for the duration, against a
`connection_limit` that §10 already flags as too small. It also needs the app to
stop connecting as the table owner (RLS does not apply to the owner without
`FORCE ROW LEVEL SECURITY`), plus policies on 29 tables and an audited bypass path
for the 68 legitimate `systemPrisma` call sites.

That is worth doing. It is not worth doing quickly, and it wants a load test on the
other side of it. What this wave did instead is make the guardrail actually hold the
line it claims to — which removes the specific shapes that leak, and makes the
remaining cross-tenant reads explicit, named, and tested.

### Wave 4 — prove it

14. A load test (k6 or Artillery) at 100 concurrent sessions driving the real poll mix,
    plus a burst of 100 simultaneous flow executions. None of the above is confirmed
    fixed without one — this audit is static analysis only.

---

## Open decision — per-org Slack / Resend (§3)

The global `SLACK_BOT_TOKEN` / `RESEND_API_KEY` are the last structural cross-org data
path, and closing them is not a pure bug fix — it takes something away from every org
that is using the shared account today. Three options:

- **Per-org required.** Add `slack` / `email` to `IntegrationSecret`, drop the env
  fallback. Cleanest isolation; every existing org's Slack and email tools go dark
  until an admin connects. Needs an in-app prompt and a heads-up.
- **Per-org with env fallback (the Granola shape).** Per-org key wins, global key still
  works when unset. Nothing breaks, but the leak stays open for every org that doesn't
  configure one — it converts a hard boundary into an opt-in.
- **Per-org required, env fallback restricted to internal orgs.** The global account
  keeps working for `kind: 'internal'` / `'partner'` workspaces only; customer orgs
  must connect their own. Preserves your and People.ai's setup, closes the boundary
  where it actually matters.

The third is the one I'd pick. It needs your call before I build it.

---

## Verification performed on the Wave 1 changes

- `tsc --noEmit` clean; `eslint` 0 errors (8 pre-existing warnings, none in new files).
- `npm test` — 1377 pass, 0 fail, 6 skipped (the DB-backed suites, which need
  `TEST_DATABASE_URL`; CI runs them).
- 10 new tests: `src/lib/__tests__/org-transfer.test.ts` (revocation is scoped to the
  org being left, same-org is a no-op, no-prior-org moves without revoking, the invited
  role applies) and `src/lib/client/__tests__/cache-owner.test.ts` (sign-out, account
  switch, same-user reload, unclaimed cache, layout prefs preserved, memory cache
  dropped alongside localStorage).
- The migration was applied to a scratch Postgres against a fixture holding a stranded
  row, a live row, and an orphan-user row: stranded and orphan deleted, live preserved,
  old index dropped, new index created. Confirmed the same user can now hold the same
  provider in two workspaces, and that a genuine in-workspace duplicate is still
  rejected by the constraint.

Not verified: the DB-backed route-smoke suite (runs in CI), and none of this has been
exercised under concurrent load.

## Verification performed on the Wave 2 changes

- `tsc --noEmit` clean; `eslint` 0 errors; `npm test` — 1394 pass, 0 fail, 6 skipped.
- 17 new tests: `scan.test.ts` (complete multi-page scan, exactly-full final page,
  empty table, the backstop *reporting* truncation rather than hiding it, stalest
  ordering, and that a capped overflow rotates on the next tick), `owners.test.ts`
  (named owner, org fallback, a named owner who left the org, a deactivated owner,
  an org with no active members, multi-org batches), `org-capacity.test.ts`
  (ceiling, in-tick accumulation, one saturated org not blocking another).
- `prisma migrate diff --from-migrations --to-schema-datamodel` reports **no
  difference** — the migration history reproduces the declared schema exactly.
- The full migration history (all 43) applies cleanly to a fresh Postgres.
- Runtime-probed the rewritten scan against a real database, because
  `Prisma.AnyNull` in a `not:` filter is the kind of thing that typechecks and then
  throws: it executes, excludes both SQL NULL and JSON null (matching the
  `publishedGraph == null` check it replaced), keeps `publishedGraph` out of the
  payload, and the cursor pagination behaves.

**Coverage gap, stated plainly:** the cron route's own glue has no automated test —
it is `CRON_SECRET`-gated and excluded from the route-smoke harness. The reason the
selection logic was extracted into `scan.ts` / `owners.ts` / `org-capacity.ts` is that
those are the parts that carry the bugs, and they *are* unit-tested. The wiring in
`route.ts` is verified by typecheck and reading only.

---

# Wave 5 — scaling to 1,000 concurrent users

Date: 2026-08-23 · Scope: the six-step sequence agreed after re-auditing the
repo against a 10x target. Waves 1–3 above were sized for 100 users and are
largely closed; what follows is what does not survive 1,000.

## The arithmetic that drove the priorities

At 1,000 concurrent users, before anyone does any work:

- the app shell polls `/api/snapshot` every 8s → **~125 req/s**
- each poll is one auth row read plus eight parallel queries → **~1,100
  Postgres queries/sec** generated by people who only have the tab open

Every item below is ranked against that number, not against a feature list.

## 1. Load test — `scripts/load/shell-poll.js` (`npm run load:shell:{100,400,1000}`)

The two existing k6 scripts drive the PUBLIC API with a bearer key, which is not
the load that breaks first. This one drives SESSION traffic through a real
Supabase cookie, minted at the token endpoint exactly as `e2e/support/session.ts`
does, and layers a burst of executions on top of the steady poll so read and run
capacity contend for the same connection pool — testing either alone measures a
machine that does not exist.

It **refuses to run** with fewer than one account per 50 VUs unless explicitly
overridden. Pointing 1,000 VUs at one account would return a ~100% cache hit
rate and report a latency profile no real deployment will see: the test would
"pass" by measuring Redis instead of Postgres.

Headline metrics: `snapshot_304` (share of polls costing no queries),
`snapshot_bytes`, `server_errors`, and `throttled` — counted separately from
errors, because under backpressure a 429 with `Retry-After` is the CORRECT
answer and the run should still pass.

**Not yet run.** It needs a staging URL and a pool of test accounts.

## 2. Snapshot diet — `src/lib/server/snapshot-version.ts`

The obvious fix (cache the response per (org, user) for ~5s) is close to
worthless here and the reason is worth recording: the poll interval is 8s and
the TTL would be 5s, so a user's next poll almost always lands after their own
entry expired. Near-zero hit rate for the traffic that exists.

What is true about this workload is that the data is nearly always *unchanged*.
So the question per poll is not "do I have a recent copy" but "has anything
happened since the copy the client already has" — an ETag, provided the
validator is cheap to compute. Hence a per-workspace mutation counter: one
integer, bumped on write, read on poll. **A matching validator returns 304
having run zero database queries.**

The bump lives in the Prisma extension, one layer below the tenant guard, so it
covers `systemPrisma` too — the worker updates run status through it ~8 times
per run, and those are exactly the writes the activity pane exists to show.

Verified end to end against real Postgres + Redis
(`src/app/api/__tests__/snapshot-revalidation.db.test.ts`): validator emitted,
unchanged poll answered 304 with no body, a write invalidating it, and two
members of one workspace never sharing a validator.

**Not done: trimming the wire shape.** `agent-config-form.tsx` is fed from the
same list the shell polls and reads `instructions`, `toolSettings`,
`httpEndpoints`, `skills`, `subagentIds`, `flowIds`. Trimming to list fields
requires the editor to fetch the full agent on open — a real refactor across the
agents surface, not a payload tweak. With 304s carrying no body at all, payload
size stops being the steady-state cost anyway.

## 3. Version-stamped auth cache — `src/lib/server/auth-cache.ts`

`dbUserCache` was deleted in Wave 1 because every field it held is an authority
field and a module-level Map cannot be invalidated across instances. The comment
left in `auth-utils.ts` named the only acceptable replacement: a shared backend
with explicit invalidation. This is that, plus one change — **the invalidation is
not left to call sites**, because two member routes forgetting to invalidate is
how the original bug reached production.

Residual staleness, stated exactly: user-row writes evict immediately and
globally (deactivation, role change, platform role, org transfer). Writes to the
ORGANIZATION row, whose fields ride along on the cached include, are bounded by
a 10s TTL instead — name, plan, logo, and entitlement tier. The first three are
display; the fourth is re-checked at dispatch against the live row.

## 4. `nextRunAt` + index — migration `20260823120000_scheduler_next_run_at`

The tick read every active agent and flow every 60 seconds, because dueness
lives in a JSON column and in cron strings. Correct at a few hundred rows, and
O(table) forever — with a 20,000-row backstop whose only behaviour on being
crossed is to reintroduce the silent truncation the complete scan removed.

`nextRunAt` is a **pre-filter, never the authority** — `isDue()` still runs on
every row read. Every choice rounds toward "examine it": NULL means "recompute
me" and is always read, so a write path that does not maintain the column costs
a wasted read rather than a schedule that silently stops.

The tick **self-heals**: writes only ever mark a row NULL (forced at the Prisma
chokepoint, which needs no knowledge of the row's other fields and so works for
`updateMany` alike), and the tick recomputes and stamps every row it examined,
grouped by instant so it costs a handful of `updateMany`s. Backfilled to NULL
deliberately — computing it in SQL would mean a second copy of
isDue/nextOccurrence that could disagree with the TypeScript one.

One caveat found while building it: a recurring agent in queue mode is due but
fired by BullMQ, not by this tick. Stamping from its real `lastExecutedAt` would
compute "due now" and pin every recurring agent into every tick's read set — so
those anchor at `now` instead.

## 5. Worker pool split — `fly.worker-batch.toml`, `WORKER_POOL`

Six queues shared ~20 slots between "a person is waiting" and "an operator
kicked off a bench". One backfill against a slow provider API could hold
interactive slots for minutes, and scaling did not fix it — it bought more slots
for the same contention. `interactive` (agent, scheduled-agent, flow) and
`batch` (template generation, bench, activity backfill) are now separate apps
with separate concurrency; `all` remains the default so nothing changes until
each app opts in. A test pins that the two pools **partition** the queue set — a
queue in neither is work that silently never runs.

The capacity math is now written into `fly.worker.toml`, because both ceilings
breach silently: at 3 machines the fleet is 45 slots, so with
`ORG_MAX_INFLIGHT_RUNS=10` **five busy workspaces saturate the platform** — that
is the number to size against, not the user count. And every slot is a database
connection, so `connection_limit x machine count` must stay under the pooler's
client ceiling before Vercel's lambdas take theirs.

**Needs you:** the pooler's actual client limit, and the Upstash plan. Both are
console-side and unverified. Fly cannot autoscale a process with no
`[[services]]` block on queue depth; `/api/cron/queue-watch` is the signal and
scaling stays a deliberate `fly scale count`.

## 6. Backpressure — `src/lib/resilience/circuit-breaker.ts`

Every outbound dependency fails the same way under stress: not by refusing
quickly, but by getting slow. Requests pile up against a timeout, each holding a
worker slot and a database connection, so a dependency slowing down converts
directly into the platform running out of what it needs to serve everything
else.

Neo4j already had a purpose-built breaker; its pure state machine moved to
`src/lib/resilience/breaker-state.ts` and the new keyed registry is built **on**
it rather than beside it. Wired into:

- **Nango**, keyed per *connection*. The thing usually sick is one workspace's
  credential, and a provider-wide breaker would let that stop Slack for
  everyone. Non-auth 4xx does not count — a bad channel id is a fact about the
  request, and counting it would let one misconfigured flow step take an
  integration down.
- **The LLM chain**, keyed per endpoint. The chain already fell back on
  availability errors, but only after paying that provider's full timeout, per
  turn, per run. With the breaker open the sick endpoint is skipped in
  microseconds.

An open circuit surfaces as **503 with `Retry-After`**, not 500: a 500 invites an
immediate retry into the dependency the breaker is protecting, and pages someone
about an application fault that is not one.

Scope limit, stated plainly: breaker state is per-process. On the worker — where
essentially all outbound volume lives — that is exactly right. On Vercel a
short-lived lambda may not observe enough failures to trip, so breakers there
trip late or not at all. Fixing that with shared state would add a cache round
trip to the very path whose job is to fail fast.

## Verification

- `tsc --noEmit` clean; `eslint` 0 errors (19 pre-existing warnings).
- `npm test` in CI mode (`TEST_DATABASE_URL` against local Postgres 
  with pgvector): **3,721 pass, 0 fail, 9 skipped**.
- The auth-sensitive DB suites re-run with `REDIS_URL` set, which activates the
  new auth cache for the first time: route-smoke, member-reach,
  deprovision-revokes, free-tier-enforcement — **100 pass, 0 fail**.
- `prisma migrate diff --from-migrations --to-schema-datamodel` reports **no
  difference**; the full history applies cleanly to a fresh database.
- 47 new tests across snapshot versioning, auth-cache invalidation and date
  revival, `nextRunAt`, the worker pool split, and the breaker registry.

**Not verified:** any of it under load. The k6 script exists and has not been
run. Until it has, this wave is a set of well-tested mechanisms, not a proven
capacity number.

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

100 users with a flow open is ~50 req/s on the flow poll alone, each an authenticated
Prisma round-trip. Each `/api/snapshot` is 6 queries including `agentTask` `take: 300`
with full row payloads.

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

5. Rewrite cron candidate selection: due-in-SQL, ordered by staleness, cursor-paginated,
   indexed `(status, lastExecutedAt)` on `AgentTask` and `Flow` (§7).
6. Cron enqueues instead of running inline; hoist the per-agent user lookup (§8).
7. Scale workers horizontally and add a per-org in-flight cap at dequeue (§9).
8. Split the worker's `DATABASE_URL` with a real pool; confirm Vercel's (§10).
9. Confirm Upstash env vars are live so rate limits and the usage counter are actually
   shared; then extend `rateLimit()` to all mutating routes (§13).

### Wave 3 — structural hardening

10. Postgres RLS on org-carrying tables, with the tenant guard kept as a dev signal (§5).
11. Targeted review + tests on the four cross-tenant `systemPrisma` session routes (§6).
12. Replace 2s polling with Realtime/SSE on run progress (§14).
13. Cap the Neo4j non-index fallback; cache/authenticate `/api/health`; bound
    `seededMemo` (§11, §12, §15).

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

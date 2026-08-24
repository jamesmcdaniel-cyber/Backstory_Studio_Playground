# Queue incident runbook

Triage for the BullMQ queue plane (Vercel producer + Fly worker consumer,
`EXECUTION_MODE=queue`). Start at `/api/health` — it fans out to Postgres,
cache, and `probeQueueConsumers()` (`src/lib/queue/consumer-probe.ts`) and is
what `.github/workflows/health-monitor.yml` polls every 10 minutes.

Anonymous callers get only `{status, timestamp}`. For the full `checks` block
(queue topology, dead-letters, heartbeat, tick), send
`Authorization: Bearer <HEALTH_DETAIL_TOKEN or CRON_SECRET>`:

```bash
curl -s -H "Authorization: Bearer $HEALTH_DETAIL_TOKEN" https://<prod-host>/api/health | jq .checks
```

Relevant fields: `checks.queueConsumers.{ok,stranded,reports,deadLetters,heartbeat,tick}`.

## 1. Dead-letter queue (DLQ) count > 0

`checks.queueConsumers.deadLetters` reports `{ total, queues }` across the
three DLQs (`agent-dead-letter`, `flow-dead-letter`,
`template-generation-dead-letter` — `QUEUE_NAMES` in `src/lib/queue/config.ts`).
A non-zero total means a job exhausted its single attempt (agent/flow jobs are
**not** auto-retried — they have external side effects, see
`src/lib/queue/dead-letter.ts` and `flow-dead-letter.ts`) and the owning
`AgentExecution`/`FlowRun` row was already marked `failed` by the dead-letter
handler.

Diagnose:

- Inspect the backlog with `scripts/queue-dlq.ts` (below), or the operator API
  at `/api/admin/queue/dead-letters`.
- Each dead-lettered job carries `{ queue, jobId, jobName, executionId |
  flowRunId, organizationId, data, error }`. `captureError` also reports it to
  Sentry under the job's queue name — cross-reference there for the stack
  trace, since the DLQ record itself only keeps the message (truncated to 300
  chars on the DB row).
- A DLQ count that keeps climbing while the rest of `checks` is healthy points
  at a code-level failure mode (a bad step config, a downstream API outage)
  rather than an infra outage — the queue plane is doing its job by capturing
  it instead of losing it silently.

### `scripts/queue-dlq.ts`

Needs `REDIS_URL` — the same one Vercel enqueues to (see §2; pointed at the
wrong Redis it simply reports an empty backlog).

```bash
REDIS_URL='rediss://...' npx tsx scripts/queue-dlq.ts counts
REDIS_URL='rediss://...' npx tsx scripts/queue-dlq.ts list --limit 20
REDIS_URL='rediss://...' npx tsx scripts/queue-dlq.ts show agent-dead-letter:41
REDIS_URL='rediss://...' npx tsx scripts/queue-dlq.ts replay agent-dead-letter:41 --confirm
REDIS_URL='rediss://...' npx tsx scripts/queue-dlq.ts drop agent-dead-letter:41 --confirm
```

`list` prints the id every other subcommand takes (`<dlq-name>:<jobId>`), the
originating queue, the run id, and the failure message. `--json` on any
subcommand gives machine-readable output. `replay` and `drop` refuse to run
without `--confirm`.

### `/admin/queue` and `/api/admin/queue/dead-letters`

The same operations over HTTP. Gated on `platform.administer` and
internal-edition only, because a parked payload is another workspace's raw job
data.

`/admin/queue` is the operator page over this route — the backlog, each
failure, each payload, and replay/drop behind a confirm. It is where the
"Queue plane needs attention" notification links, so an owner who gets the
alert on a phone can triage without production secrets. `curl` below is the
same surface for a terminal.

```bash
curl -s "$HOST/api/admin/queue/dead-letters" -H "Cookie: $OPERATOR_SESSION" | jq
curl -s "$HOST/api/admin/queue/dead-letters?id=agent-dead-letter:41" -H "Cookie: $OPERATOR_SESSION" | jq
curl -sX POST "$HOST/api/admin/queue/dead-letters" -H "Cookie: $OPERATOR_SESSION" \
  -H 'content-type: application/json' \
  -d '{"action":"replay","id":"agent-dead-letter:41","confirm":true}'
```

`confirm: true` is required on every POST. Replays are audited
(`platform.dead_letter_replayed` / `platform.dead_letter_dropped`).

### When to replay, and when not to

There is no auto-retry path by design. **Prefer re-running the flow/agent from
the UI** once the underlying cause is fixed: that path ties into the
run-history state the app owns, whereas a raw replay re-enqueues the original
job data and leaves the old `failed` run row as it is.

Replay is the right tool when the app-level re-run is unavailable or wrong —
a scheduled agent job with no user to re-trigger it, or a large batch of jobs
that failed on one downstream outage and need requeueing en masse. It is safe
in the sense that a re-run resumes from the last checkpointed turn and replays
already-completed tool calls from the step ledger rather than re-firing them,
but that only holds downstream of a checkpoint — treat a replay of a job that
failed early as capable of repeating side effects.

Replay re-enqueues onto the ORIGINAL queue (constrained to the queues that DLQ
serves — a tampered record cannot redirect work elsewhere) and only then
removes the DLQ record, so an interrupted replay can duplicate a job but never
loses one.

## 2. Stale worker heartbeat (split-brain Redis)

`checks.queueConsumers.heartbeat` = `{ ageMs, fresh }`. The worker writes
`worker:heartbeat` to Redis every 60s (`WORKER_HEARTBEAT_INTERVAL_MS`,
`src/lib/queue/heartbeat.ts`); `fresh` requires an age under
`WORKER_HEARTBEAT_STALE_MS` (3 minutes — three missed intervals). Dispatch
itself is gated on this: `assertQueueConsumerAlive()` refuses to enqueue a
flow run and returns `EXECUTION_BACKEND_OFFLINE_MESSAGE` when neither the
heartbeat nor a registered BullMQ consumer (`getWorkers()`) is alive.

**A healthy-looking Fly fleet with a stale heartbeat is the split-brain Redis
signature** — documented in `fly.worker.toml` (lines 6-8, 31-34): the worker's
`REDIS_URL` secret must be the exact same Upstash `rediss://…:6379` URL Vercel
uses to enqueue. If they diverge, the worker writes its heartbeat and consumes
jobs against a Redis instance nothing is producing into, while Vercel enqueues
into a different, unconsumed one — this is precisely the class of outage that
shipped on 2026-08-04 (runs stuck at "Thinking…"/"No steps recorded" with zero
registered workers on any queue).

Diagnose:

```bash
fly secrets list --config fly.worker.toml -a backstory-worker   # confirm REDIS_URL is set (value redacted)
```

Compare it against the Vercel production `REDIS_URL` (Vercel dashboard, or
`npx vercel env pull` to a scratch file — never commit it). They must be
byte-identical. If they differ:

```bash
fly secrets set REDIS_URL='rediss://...' --config fly.worker.toml -a backstory-worker
```

This restarts the worker machines. Confirm recovery: `checks.queueConsumers.ok`
flips to `true` and `heartbeat.fresh` to `true` within ~3 minutes.

If the URLs already match and the heartbeat is still stale, the worker
process itself is down or crash-looping — check `fly logs -a backstory-worker`
and `fly status -a backstory-worker` before touching Redis.

## 3. Stuck `running` runs

Two independent reapers exist, both invoked from the CRON_SECRET-gated
dispatch tick (`src/lib/flows/reap.ts`):

- **`reapNeverPickedUpRuns`** — a `FlowRun` still `running` with **zero**
  recorded steps after `NEVER_PICKED_UP_TIMEOUT_MS` (5 minutes,
  `src/lib/flows/run-stall.ts`) was never consumed by the execution backend —
  a picked-up run records its first step within seconds. This is the fast
  path for the exact 2026-08-04 outage shape. Marked failed with
  `NEVER_PICKED_UP_ERROR`.
- **`reapStuckFlowRuns`** — any `FlowRun` still `running` past
  `STUCK_FLOW_RUN_TIMEOUT_MS` (45 minutes — chosen to exceed the 1800s/30min
  route budget plus slack) is failed regardless of step count, along with its
  still-live steps. This catches a process that died mid-execution rather
  than one that was never picked up.

Both reapers re-check `status: 'running'` inside their write transaction, so a
run that legitimately left `running` between the read and the write (e.g.
paused for human approval) is left alone.

If runs are piling up in `running` faster than the reapers can be trusted to
clear them (i.e. you need to act before the next tick), fail them directly:

```sql
-- Never-picked-up runs (no steps, running > 5 min)
SELECT id, "flowId", "organizationId", "startedAt"
FROM flow_runs fr
WHERE status = 'running' AND "startedAt" < now() - interval '5 minutes'
  AND NOT EXISTS (SELECT 1 FROM flow_run_steps s WHERE s."flowRunId" = fr.id);
```

Prefer waiting for the tick (it runs every 60s off the worker, or every ~15
min off the Vercel cron alone — see `checks.queueConsumers.tick`) over a
manual UPDATE; the reapers also terminalize the associated steps correctly,
which a bare UPDATE on `flow_runs` will not do.

If `checks.queueConsumers.tick.fresh` is `false`, the scheduling tick itself
isn't running (paused/deleted Vercel cron with no worker plane driving
`dispatch-tick.ts`) — that is a *dispatch* outage, not just a stuck-run
symptom, and every scheduled flow is silently not firing. Check the Vercel
cron config (`vercel.json`) and the worker's `dispatch-tick.ts` loop.

## 4. The fly-deploy-after-runtime-change rule

**Any change to worker runtime code, `Dockerfile.worker`, or `fly.worker.toml`
requires `fly deploy --config fly.worker.toml` before it takes effect.**
Vercel deploys on every push to `main` automatically; the Fly worker does not.
A merged fix that touches `src/lib/workers/**`, `src/lib/queue/**`, or any
module the worker runtime imports keeps running the OLD image until someone
runs the Fly deploy — this has been the source of "I fixed it but it's still
broken in prod" confusion before. After deploying:

```bash
fly deploy --config fly.worker.toml -a backstory-worker
fly status -a backstory-worker        # machines healthy
fly logs -a backstory-worker          # queues consuming, no boot-audit fatals
```

Then confirm `/api/health` shows a fresh heartbeat and `queueConsumers.ok: true`.

## 5. What CI already proves

The `check` job in `.github/workflows/ci.yml` runs a `redis:7` service and:

- exports `TEST_REDIS_URL`, which is what the Redis-backed tests gate on
  (`src/lib/queue/__tests__/dead-letter-admin.redis.test.ts` — a real
  record → list → show → replay → drop round-trip). Without it those tests
  skip **visibly**, so they cannot quietly stop running.
- boots the actual worker runtime against that Redis and the CI Postgres
  (`scripts/worker-smoke.sh`): it fails the job if the process exits during
  boot, if `/health` is not 200 with `redis: true` and every queue running, if
  a queue is missing from the health body, if the process dies during a 20s
  observation window, or if SIGTERM does not produce a clean exit.

So "the worker won't boot" and "the queue plane is misconfigured in code" are
now caught before merge. What CI still does NOT prove is the production
configuration — the split-brain Redis in §2 is an env problem and remains a
deploy-time check.

## 6. Automated watch (cron alerting, no human required)

`/api/cron/queue-watch` (`src/app/api/cron/queue-watch/route.ts`) runs every 5
minutes on Vercel Cron (`vercel.json`) and calls the same
`probeQueueConsumers()` `/api/health` uses (via `src/lib/queue/queue-watch.ts`
— no duplicated probe logic). It is CRON_SECRET-gated exactly like
`/api/cron/dispatch` and `/api/cron/retention`: fails closed with 503 if
`CRON_SECRET` is unset, 401 on a bad/missing bearer token.

**What it checks**, each tick:
- `queueConsumers.ok === false` — a critical queue (agent-execution,
  scheduled-agent-execution, flow-execution) has jobs waiting with no
  registered consumer and no fresh worker heartbeat (§2 above).
- `queueConsumers.deadLetters.total` has GROWN since the last tick — a job
  newly landed in a dead-letter queue (§1 above), independent of consumer
  health. Growth, not presence: nothing consumes a DLQ, so a parked job sits
  there until an operator drops or replays it, and alerting on presence meant
  the same "N job(s) in dead-letter queue(s)" notification every time the
  cooldown lapsed, for as long as the backlog stood. The last observed total
  lives in `queue-watch:dead-letter-baseline` (`DEAD_LETTER_BASELINE_KEY`, 30
  day TTL); it follows the count in both directions, so draining the queue
  re-arms the alert for the next failure. The condition still REPORTS
  unhealthy the whole time — only the notification is growth-gated.

**Where alerts land**: the platform owner (`PLATFORM_OWNER_EMAILS`,
`src/lib/authz/platform-owner.ts`) — the only operator identity guaranteed to
exist in every environment. For each owner account found:
- an in-app notification + best-effort web push via the existing
  `notify()` pathway (`src/lib/notifications/service.ts` — the same one
  run-completion notifications use), level `error`, linking to `/admin/queue`
  (the operator page over the backlog — §1 above);
- an `AuditEvent` (`action: 'platform.queue.alert'`, `actorKind: 'system'`)
  recording the reason, stranded queues, and dead-letter counts — durable and
  queryable even if push/in-app delivery is misconfigured;
- an `apiLogger.error` + `captureError` call, so a Sentry-integrated
  environment gets it there too (error-level is what Sentry picks up per the
  existing convention).

**Cooldown semantics**: edge-triggered, not level-triggered. State is one
cache key PER CONDITION (`queue-watch:alert-cooldown:*`, Redis-backed via
`src/lib/cache.ts` in production — so it survives across serverless
invocations) with a 1 hour TTL (`QUEUE_WATCH_COOLDOWN_MS`, override via env). While the condition stays
unhealthy, only the FIRST tick alerts; every tick after that is silent until
either the TTL lapses or the condition recovers. On a healthy tick the key is
cleared immediately (not left to expire), so a flap — recovers, then breaks
again — alerts again right away instead of waiting out the rest of an
hour-long window for what is really a new incident.

A cooldown alone is not enough for a condition whose level never recovers on
its own, which is why the dead-letter check is additionally gated on growth
(above): the cooldown decides how often ONE incident may speak, the baseline
decides whether there is a new incident at all.

**Failures that are deliberately not dead-lettered**: a flow job that fails
`FLOW_VALIDATION_ERROR` (its graph no longer validates — e.g. a step pointing
at a deleted agent) terminalizes its run but parks nothing
(`isDeterministicUserFailure`, `src/lib/queue/flow-dead-letter.ts`). Replaying
it would fail identically, and the fix belongs to the flow's owner, who
already has the message on the run. Everything else — including
`FLOW_DEPENDENCY_DRIFT`, whose payload becomes replayable once the fleets
agree — still parks.

**External uptime monitor recommendation**: point a third-party monitor
(Pingdom, UptimeRobot, Better Uptime, etc.) at `GET /api/health` expecting
HTTP `200` with this anonymous body:

```json
{ "status": "ok", "timestamp": "<ISO 8601>" }
```

A `503` (body `{"status":"unhealthy",...}`) means Postgres, cache, or the
queue consumer check failed — see §§1-3 above. This is complementary to the
cron watch, not redundant: the external monitor catches the whole app being
unreachable (DNS, TLS, Vercel outage) or a non-queue failure (Postgres down),
which a queue-scoped cron running inside the same deployment cannot detect
about itself. The existing `.github/workflows/health-monitor.yml` already
does exactly this against `HEALTH_MONITOR_URL` every 10 minutes and files a
GitHub issue on failure — an external monitor is an additional,
infrastructure-independent channel for the same signal, not a replacement.

## Related

- `docs/runbooks/incident-response.md` — severity levels, escalation, postmortem template.
- `docs/runbooks/deploy.md` — alerting section, `EXECUTION_MODE` rollout order.
- `docs/runbooks/security-controls.md` §7 — health endpoint detail auth.

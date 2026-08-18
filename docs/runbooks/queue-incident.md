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

- Inspect the backlog with `npx tsx scripts/queue-dlq.ts` (added alongside
  this runbook — run `--help` for its exact flags once merged) or the admin
  dead-letters API, if the build you're on has it wired up.
- Each dead-lettered job carries `{ queue, jobId, executionId | flowRunId,
  organizationId, data, error }`. `captureError` also reports it to Sentry
  under the job's queue name — cross-reference there for the stack trace,
  since the DLQ record itself only keeps the message (truncated to 300 chars
  on the DB row).
- A DLQ count that keeps climbing while the rest of `checks` is healthy points
  at a code-level failure mode (a bad step config, a downstream API outage)
  rather than an infra outage — the queue plane is doing its job by capturing
  it instead of losing it silently.

There is no auto-retry path by design. Re-running is a user/operator action
(re-run the flow/agent from the UI) once the underlying cause is fixed — do
not requeue the raw DLQ job, since fixing it up correctly ties into
run-history state the app owns.

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

## Related

- `docs/runbooks/incident-response.md` — severity levels, escalation, postmortem template.
- `docs/runbooks/deploy.md` — alerting section, `EXECUTION_MODE` rollout order.
- `docs/runbooks/security-controls.md` §7 — health endpoint detail auth.

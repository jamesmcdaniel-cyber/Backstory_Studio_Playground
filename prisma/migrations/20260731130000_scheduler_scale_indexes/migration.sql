-- Indexes for the rewritten scheduler (see src/app/api/cron/dispatch/route.ts).
--
-- The sweep changed shape: it now scans EVERY active agent and flow by id
-- cursor instead of reading an arbitrary, unordered 200/100-row window, and it
-- reads a per-org in-flight run count once per tick to stop one workspace
-- occupying the whole worker pool. Both are new access patterns that the
-- existing [organizationId, ...] indexes cannot serve — wrong leading column —
-- so without these the tick degrades into repeated sequential scans.
--
-- Deliberately NOT `CONCURRENTLY`: Prisma runs each migration inside one
-- transaction (same constraint the RBAC enum migration documents), and Postgres
-- forbids CREATE INDEX CONCURRENTLY in a transaction. These four builds take a
-- brief write lock. That is fine at current table sizes; if any of these tables
-- ever grows large enough for the lock to hurt, build the index out-of-band with
-- CONCURRENTLY and mark this migration applied with `prisma migrate resolve`.

CREATE INDEX IF NOT EXISTS "agent_tasks_status_id_idx"
  ON "agent_tasks" ("status", "id");

CREATE INDEX IF NOT EXISTS "flows_status_id_idx"
  ON "flows" ("status", "id");

CREATE INDEX IF NOT EXISTS "agent_executions_organizationId_status_idx"
  ON "agent_executions" ("organizationId", "status");

CREATE INDEX IF NOT EXISTS "flow_runs_organizationId_status_idx"
  ON "flow_runs" ("organizationId", "status");

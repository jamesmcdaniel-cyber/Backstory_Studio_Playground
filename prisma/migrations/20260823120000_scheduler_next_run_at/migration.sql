-- Scheduler due-range index.
--
-- The tick previously read EVERY active agent and flow every 60 seconds and
-- evaluated dueness in Node, because dueness lives in a JSON schedule column
-- and in cron strings. Correct, and O(table) forever — with a 20,000-row
-- runaway backstop whose only behaviour on being crossed is to reintroduce the
-- silent truncation the complete scan existed to remove.
--
-- nextRunAt is a PRE-FILTER, never the authority: the tick still calls isDue on
-- every row it reads. NULL means "recompute me" and is always read, so the
-- failure mode of any write path that does not maintain it is extra work rather
-- than a schedule that silently stops.
--
-- Deliberately backfilled to NULL rather than to a computed value: computing it
-- here would mean reimplementing isDue/nextOccurrence — timezones, cron
-- matching, per-type anchoring — in SQL, as a second copy that could disagree
-- with the TypeScript one. Instead the first tick after deploy reads everything
-- exactly as today's code does, stamps each row as it goes, and every tick
-- after that is an index range read. One slow tick, no duplicated logic, and no
-- window in which a row could be skipped.
ALTER TABLE "agent_tasks" ADD COLUMN "nextRunAt" TIMESTAMPTZ(6);
ALTER TABLE "flows" ADD COLUMN "nextRunAt" TIMESTAMPTZ(6);

CREATE INDEX "agent_tasks_status_nextRunAt_idx" ON "agent_tasks"("status", "nextRunAt");
CREATE INDEX "flows_status_nextRunAt_idx" ON "flows"("status", "nextRunAt");

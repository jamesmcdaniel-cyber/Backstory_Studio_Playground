-- Liveness clock for agent runs: the executor stamps it every minute while the
-- run's process is alive, and the stuck-run reaper fails a run only when it
-- goes stale (src/lib/agents/reap.ts). Nullable: rows written before this
-- column, or by a worker that predates it, fall back to the startedAt rule.
ALTER TABLE "agent_executions" ADD COLUMN "lastActiveAt" TIMESTAMP(3);

-- Persist "succeeded with warnings" server-side instead of inferring it
-- per-client over a possibly-truncated step summary.
ALTER TABLE "flow_runs" ADD COLUMN "degraded" BOOLEAN NOT NULL DEFAULT false;

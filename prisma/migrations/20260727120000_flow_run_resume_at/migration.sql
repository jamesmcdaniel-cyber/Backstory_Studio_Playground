-- Wait node: when a run pauses on a timer, resumeAt is the wall-clock time it
-- should wake. The cron scan queries waiting runs whose resumeAt is due.
ALTER TABLE "flow_runs" ADD COLUMN "resumeAt" TIMESTAMP(3);

CREATE INDEX "flow_runs_status_resumeAt_idx" ON "flow_runs"("status", "resumeAt");

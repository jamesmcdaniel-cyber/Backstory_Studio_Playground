CREATE INDEX IF NOT EXISTS "flow_runs_organizationId_startedAt_idx"
  ON "flow_runs" ("organizationId", "startedAt");

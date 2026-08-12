ALTER TABLE "flows" ADD COLUMN "quarantinedAt" TIMESTAMPTZ(6);
ALTER TABLE "agent_tasks" ADD COLUMN "quarantinedAt" TIMESTAMPTZ(6);

-- Dispatch filters on this every tick; both are partial indexes because the
-- overwhelming majority of rows are NULL and never need to be visited.
CREATE INDEX "flows_quarantined_idx" ON "flows" ("quarantinedAt") WHERE "quarantinedAt" IS NOT NULL;
CREATE INDEX "agent_tasks_quarantined_idx" ON "agent_tasks" ("quarantinedAt") WHERE "quarantinedAt" IS NOT NULL;

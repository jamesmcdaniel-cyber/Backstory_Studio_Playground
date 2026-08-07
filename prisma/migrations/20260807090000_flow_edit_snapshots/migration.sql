-- Per-edit graph snapshots: History's "recent edits" become viewable and
-- restorable, not just a who/when log. One row per recorded flow.edited event.
CREATE TABLE "flow_edit_snapshots" (
  "id" TEXT NOT NULL,
  "flowId" TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "graph" JSONB NOT NULL,
  "summary" JSONB,
  "editedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "flow_edit_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "flow_edit_snapshots_organizationId_flowId_createdAt_idx" ON "flow_edit_snapshots"("organizationId", "flowId", "createdAt");

-- AddForeignKey
ALTER TABLE "flow_edit_snapshots" ADD CONSTRAINT "flow_edit_snapshots_flowId_fkey"
  FOREIGN KEY ("flowId") REFERENCES "flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "flow_edit_snapshots" ADD CONSTRAINT "flow_edit_snapshots_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation, matching every other org-scoped table.
ALTER TABLE flow_edit_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_edit_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON flow_edit_snapshots
  USING ("organizationId" = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK ("organizationId" = nullif(current_setting('app.organization_id', true), '')::uuid);

-- Published versions also record WHAT changed vs the previous version.
ALTER TABLE "flow_versions" ADD COLUMN "summary" JSONB;

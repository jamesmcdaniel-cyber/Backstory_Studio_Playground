-- Flow-template versioning: a monotonically increasing version on the template
-- plus immutable snapshots of every prior payload, so editing a saved template
-- is safe (history kept, restorable) instead of destructive.
ALTER TABLE "flow_templates" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "flow_template_versions" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    -- Full prior payload: {name, description, category, graph, trigger, notes,
    -- bindings, configuration} — everything a restore needs to reproduce the row.
    "snapshot" JSONB NOT NULL,
    "savedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "flow_template_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "flow_template_versions_templateId_version_key" ON "flow_template_versions"("templateId", "version");
CREATE INDEX "flow_template_versions_organizationId_templateId_idx" ON "flow_template_versions"("organizationId", "templateId");

ALTER TABLE "flow_template_versions" ADD CONSTRAINT "flow_template_versions_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "flow_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "flow_template_versions" ADD CONSTRAINT "flow_template_versions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Reusable, WIRED flow templates. Additive: a new table only.
-- Unlike agent_templates (one prose blob), the executable artifact is the
-- graph; `notes` explains it step by step and `bindings` says how to fill the
-- graph's empty agent/connection slots in the instantiating workspace.

-- CreateTable
CREATE TABLE "flow_templates" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "category" TEXT NOT NULL DEFAULT 'Custom',
  "graph" JSONB NOT NULL,
  "trigger" JSONB NOT NULL DEFAULT '{}',
  "notes" JSONB,
  "bindings" JSONB NOT NULL DEFAULT '[]',
  "configuration" JSONB,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "source" TEXT NOT NULL DEFAULT 'user',
  "visibility" TEXT NOT NULL DEFAULT 'org',
  "userId" TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "flow_templates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "flow_templates_organizationId_isActive_idx"
  ON "flow_templates"("organizationId", "isActive");

CREATE INDEX "flow_templates_organizationId_visibility_idx"
  ON "flow_templates"("organizationId", "visibility");

-- AddForeignKey
ALTER TABLE "flow_templates" ADD CONSTRAINT "flow_templates_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_templates" ADD CONSTRAINT "flow_templates_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

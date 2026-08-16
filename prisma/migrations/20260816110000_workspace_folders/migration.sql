-- Durable shared folders for the workspace agent tree.
--
-- AgentTask.folder remains the assignment column for compatibility with agent
-- exports and existing APIs. This catalogue row is what lets a newly-created
-- folder remain visible before an agent has been moved into it.

CREATE TABLE "workspace_folders" (
  "id"             TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "name"           TEXT NOT NULL,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workspace_folders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "workspace_folders_organizationId_idx"
  ON "workspace_folders"("organizationId");

-- Folder names are user-facing identifiers. Treat case-only variants as the
-- same folder so "Sales" and "sales" cannot split agents into lookalike rows.
CREATE UNIQUE INDEX "workspace_folders_organizationId_name_ci_key"
  ON "workspace_folders"("organizationId", lower("name"));

ALTER TABLE "workspace_folders" ADD CONSTRAINT "workspace_folders_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve every existing non-private named agent folder. DISTINCT ON picks a
-- stable display spelling if old data contains case-only variants.
INSERT INTO "workspace_folders" ("id", "organizationId", "name")
SELECT gen_random_uuid()::text, "organizationId", "folder"
FROM (
  SELECT DISTINCT ON ("organizationId", lower(btrim("folder")))
    "organizationId", btrim("folder") AS "folder"
  FROM "agent_tasks"
  WHERE "status" <> 'DELETED'
    AND "visibility" <> 'private'
    AND "folder" IS NOT NULL
    AND btrim("folder") <> ''
    AND lower(btrim("folder")) <> 'general'
  ORDER BY "organizationId", lower(btrim("folder")), btrim("folder")
) existing;

ALTER TABLE "workspace_folders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_folders" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "workspace_folders"
  USING ("organizationId" = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK ("organizationId" = nullif(current_setting('app.organization_id', true), '')::uuid);

-- The RLS-constrained application role needs ordinary table privileges; the
-- policy above is what limits those privileges to the active organization.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backstory_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "workspace_folders" TO backstory_app;
  END IF;
END
$$;

-- This table is server-only like the rest of the Prisma application schema.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "workspace_folders" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "workspace_folders" FROM authenticated;
  END IF;
END
$$;

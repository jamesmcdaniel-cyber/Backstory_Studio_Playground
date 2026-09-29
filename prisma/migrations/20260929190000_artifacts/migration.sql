-- Artifacts: what agents produce, kept as first-class things.
--
-- An artifact is the durable handle on a report, dashboard or document an
-- agent (or a flow's agent step) emitted. Every emission is a version tied
-- to the run that made it; asking the producing agent for a change makes
-- another version, never overwrites one. The conversation about an artifact
-- lives on the artifact, not on the run.
CREATE TABLE "artifacts" (
  "id"               TEXT NOT NULL,
  "organizationId"   UUID NOT NULL,
  "userId"           TEXT,
  "kind"             TEXT NOT NULL DEFAULT 'report',
  "title"            TEXT NOT NULL,
  "agentTaskId"      TEXT,
  "flowId"           TEXT,
  "currentVersionId" TEXT,
  "versionCount"     INTEGER NOT NULL DEFAULT 0,
  "chat"             JSONB NOT NULL DEFAULT '[]',
  "archivedAt"       TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "artifacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "artifacts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "artifacts_organizationId_updatedAt_idx" ON "artifacts"("organizationId", "updatedAt");
CREATE INDEX "artifacts_organizationId_agentTaskId_idx" ON "artifacts"("organizationId", "agentTaskId");
CREATE INDEX "artifacts_organizationId_kind_idx" ON "artifacts"("organizationId", "kind");

CREATE TABLE "artifact_versions" (
  "id"             TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "artifactId"     TEXT NOT NULL,
  "number"         INTEGER NOT NULL,
  "executionId"    TEXT,
  "flowRunId"      TEXT,
  "request"        TEXT,
  "content"        TEXT NOT NULL,
  "createdByUserId" TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "artifact_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "artifact_versions_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "artifact_versions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "artifact_versions_artifactId_number_key" ON "artifact_versions"("artifactId", "number");
CREATE UNIQUE INDEX "artifact_versions_executionId_key" ON "artifact_versions"("executionId");
CREATE INDEX "artifact_versions_organizationId_createdAt_idx" ON "artifact_versions"("organizationId", "createdAt");

DO $rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'artifacts', 'artifact_versions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("organizationId" = nullif(current_setting(''app.organization_id'', true), '''')::uuid) WITH CHECK ("organizationId" = nullif(current_setting(''app.organization_id'', true), '''')::uuid)',
      table_name
    );

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backstory_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO backstory_app', table_name);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon', table_name);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM authenticated', table_name);
    END IF;
  END LOOP;
END
$rls$;

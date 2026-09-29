-- ROI analyses: one row per "build the ROI story for account X over time
-- frame Y" request. The agent run that does the work is an ordinary
-- AgentExecution; this row is the page's handle on it — what was asked, which
-- datasets were used, the rendered dashboard once the run finished, and the
-- follow-up conversation.
CREATE TABLE "roi_analyses" (
  "id"             TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "userId"         TEXT NOT NULL,
  "agentTaskId"    TEXT,
  "executionId"    TEXT,
  "account"        TEXT NOT NULL,
  "timeframe"      JSONB NOT NULL DEFAULT '{}',
  "context"        TEXT NOT NULL DEFAULT '',
  "datasetIds"     JSONB NOT NULL DEFAULT '[]',
  "status"         TEXT NOT NULL DEFAULT 'pending',
  "error"          TEXT,
  "results"        JSONB,
  "reportHtml"     TEXT,
  "chat"           JSONB NOT NULL DEFAULT '[]',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "roi_analyses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "roi_analyses_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "roi_analyses_organizationId_createdAt_idx" ON "roi_analyses"("organizationId", "createdAt");
CREATE INDEX "roi_analyses_organizationId_userId_idx" ON "roi_analyses"("organizationId", "userId");
CREATE UNIQUE INDEX "roi_analyses_executionId_key" ON "roi_analyses"("executionId");

DO $rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'roi_analyses'
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

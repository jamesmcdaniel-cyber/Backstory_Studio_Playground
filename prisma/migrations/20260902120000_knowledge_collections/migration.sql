CREATE TABLE "knowledge_collections" (
  "id"             TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "name"           TEXT NOT NULL,
  "description"    TEXT NOT NULL DEFAULT '',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "knowledge_collections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "knowledge_document_collections" (
  "documentId"     TEXT NOT NULL,
  "collectionId"   TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  CONSTRAINT "knowledge_document_collections_pkey" PRIMARY KEY ("documentId", "collectionId")
);

CREATE TABLE "agent_knowledge_collections" (
  "agentId"        TEXT NOT NULL,
  "collectionId"   TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  CONSTRAINT "agent_knowledge_collections_pkey" PRIMARY KEY ("agentId", "collectionId")
);

CREATE UNIQUE INDEX "knowledge_collections_organizationId_name_key"
  ON "knowledge_collections" ("organizationId", "name");
CREATE INDEX "knowledge_collections_organizationId_updatedAt_idx"
  ON "knowledge_collections" ("organizationId", "updatedAt");
CREATE INDEX "knowledge_document_collections_organizationId_collectionId_idx"
  ON "knowledge_document_collections" ("organizationId", "collectionId");
CREATE INDEX "agent_knowledge_collections_organizationId_agentId_idx"
  ON "agent_knowledge_collections" ("organizationId", "agentId");

ALTER TABLE "knowledge_collections"
  ADD CONSTRAINT "knowledge_collections_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "knowledge_document_collections"
  ADD CONSTRAINT "knowledge_document_collections_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "knowledge_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_document_collections"
  ADD CONSTRAINT "knowledge_document_collections_collectionId_fkey"
  FOREIGN KEY ("collectionId") REFERENCES "knowledge_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_knowledge_collections"
  ADD CONSTRAINT "agent_knowledge_collections_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_knowledge_collections"
  ADD CONSTRAINT "agent_knowledge_collections_collectionId_fkey"
  FOREIGN KEY ("collectionId") REFERENCES "knowledge_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation, byte-for-byte the block from
-- 20260827160000_rls_flow_reviews_audit_streams. The application queries are
-- already org-scoped; this makes the database enforce the same boundary and
-- keeps direct SQL mistakes fail-closed.
DO $rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'knowledge_collections', 'knowledge_document_collections', 'agent_knowledge_collections'
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

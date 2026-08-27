-- Durable tenant-scoped workflow tables. The schema is JSON because customer
-- columns are data, not physical PostgreSQL columns; every row still carries
-- organizationId so both the application guard and RLS can enforce tenancy.
CREATE TABLE "data_tables" (
  "id"             TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "name"           TEXT NOT NULL,
  "description"    TEXT NOT NULL DEFAULT '',
  "columns"        JSONB NOT NULL DEFAULT '[]',
  "version"        INTEGER NOT NULL DEFAULT 1,
  "createdById"    TEXT,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "data_tables_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "data_table_rows" (
  "id"             TEXT NOT NULL,
  "tableId"        TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "data"           JSONB NOT NULL DEFAULT '{}',
  "createdById"    TEXT,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "data_table_rows_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "data_tables_organizationId_name_key" ON "data_tables"("organizationId", "name");
-- Product identifiers are case-insensitive. Keep Prisma's declared composite
-- unique constraint above and enforce the stronger invariant at the database
-- boundary so API, MCP and direct service callers cannot create Sales/sales.
CREATE UNIQUE INDEX "data_tables_organizationId_lower_name_key"
  ON "data_tables"("organizationId", lower("name"));
CREATE INDEX "data_tables_organizationId_updatedAt_idx" ON "data_tables"("organizationId", "updatedAt");
CREATE INDEX "data_table_rows_organizationId_tableId_createdAt_idx" ON "data_table_rows"("organizationId", "tableId", "createdAt");
CREATE INDEX "data_table_rows_tableId_updatedAt_idx" ON "data_table_rows"("tableId", "updatedAt");

ALTER TABLE "data_tables" ADD CONSTRAINT "data_tables_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "data_table_rows" ADD CONSTRAINT "data_table_rows_tableId_fkey"
  FOREIGN KEY ("tableId") REFERENCES "data_tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "data_table_rows" ADD CONSTRAINT "data_table_rows_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DO $rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['data_tables', 'data_table_rows'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
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

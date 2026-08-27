CREATE TABLE "external_secret_providers" (
  "id"                  TEXT NOT NULL,
  "organizationId"      UUID NOT NULL,
  "name"                TEXT NOT NULL,
  "provider"            TEXT NOT NULL,
  "config"              JSONB NOT NULL DEFAULT '{}',
  "authConfig"          TEXT,
  "allowedPathPrefix"   TEXT NOT NULL DEFAULT '',
  "cacheTtlSeconds"     INTEGER NOT NULL DEFAULT 60,
  "status"              TEXT NOT NULL DEFAULT 'unverified',
  "lastVerifiedAt"      TIMESTAMP(3),
  "lastError"           TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "external_secret_providers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "external_secret_providers_cache_ttl_check" CHECK ("cacheTtlSeconds" BETWEEN 0 AND 300),
  CONSTRAINT "external_secret_providers_type_check" CHECK ("provider" IN ('aws', 'gcp', 'azure', 'vault')),
  CONSTRAINT "external_secret_providers_status_check" CHECK ("status" IN ('unverified', 'verified', 'error', 'disabled'))
);

CREATE TABLE "http_credential_secret_references" (
  "id"             TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "credentialId"   TEXT NOT NULL,
  "providerId"     TEXT NOT NULL,
  "field"          TEXT NOT NULL,
  "path"           TEXT NOT NULL,
  "property"       TEXT,
  "version"        TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "http_credential_secret_references_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "external_secret_providers_organizationId_name_key"
  ON "external_secret_providers"("organizationId", "name");
CREATE INDEX "external_secret_providers_organizationId_provider_status_idx"
  ON "external_secret_providers"("organizationId", "provider", "status");
CREATE UNIQUE INDEX "http_credential_secret_references_organizationId_credential_key"
  ON "http_credential_secret_references"("organizationId", "credentialId", "field");
CREATE INDEX "http_credential_secret_references_organizationId_providerId_idx"
  ON "http_credential_secret_references"("organizationId", "providerId");

ALTER TABLE "external_secret_providers" ADD CONSTRAINT "external_secret_providers_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "http_credential_secret_references" ADD CONSTRAINT "http_credential_secret_references_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "http_credential_secret_references" ADD CONSTRAINT "http_credential_secret_references_credentialId_fkey"
  FOREIGN KEY ("credentialId") REFERENCES "http_credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "http_credential_secret_references" ADD CONSTRAINT "http_credential_secret_references_providerId_fkey"
  FOREIGN KEY ("providerId") REFERENCES "external_secret_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DO $rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['external_secret_providers', 'http_credential_secret_references'] LOOP
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

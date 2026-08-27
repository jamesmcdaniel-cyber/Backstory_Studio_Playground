CREATE TABLE "credential_resolvers" (
  "id"              TEXT NOT NULL,
  "organizationId"  UUID NOT NULL,
  "createdByUserId" TEXT,
  "name"            TEXT NOT NULL,
  "authType"        TEXT NOT NULL,
  "allowedHost"     TEXT NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'active',
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "credential_resolvers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "credential_resolvers_auth_type_check" CHECK ("authType" IN ('basic', 'bearer', 'custom', 'digest', 'header', 'oauth1', 'oauth2', 'query')),
  CONSTRAINT "credential_resolvers_status_check" CHECK ("status" IN ('active', 'disabled')),
  CONSTRAINT "credential_resolvers_host_check" CHECK (length("allowedHost") BETWEEN 1 AND 253 AND "allowedHost" = lower("allowedHost"))
);

CREATE TABLE "credential_resolver_bindings" (
  "id"             TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "resolverId"     TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "credentialId"   TEXT NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "credential_resolver_bindings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "credential_resolvers_organizationId_name_key"
  ON "credential_resolvers"("organizationId", "name");
CREATE UNIQUE INDEX "credential_resolvers_org_name_lower_key"
  ON "credential_resolvers"("organizationId", lower("name"));
CREATE INDEX "credential_resolvers_organizationId_authType_allowedHost_st_idx"
  ON "credential_resolvers"("organizationId", "authType", "allowedHost", "status");
CREATE INDEX "credential_resolvers_createdByUserId_idx" ON "credential_resolvers"("createdByUserId");
CREATE UNIQUE INDEX "credential_resolver_bindings_organizationId_resolverId_user_key"
  ON "credential_resolver_bindings"("organizationId", "resolverId", "userId");
CREATE INDEX "credential_resolver_bindings_organizationId_credentialId_idx"
  ON "credential_resolver_bindings"("organizationId", "credentialId");
CREATE INDEX "credential_resolver_bindings_userId_idx" ON "credential_resolver_bindings"("userId");

ALTER TABLE "credential_resolvers" ADD CONSTRAINT "credential_resolvers_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "credential_resolvers" ADD CONSTRAINT "credential_resolvers_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "credential_resolver_bindings" ADD CONSTRAINT "credential_resolver_bindings_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "credential_resolver_bindings" ADD CONSTRAINT "credential_resolver_bindings_resolverId_fkey"
  FOREIGN KEY ("resolverId") REFERENCES "credential_resolvers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "credential_resolver_bindings" ADD CONSTRAINT "credential_resolver_bindings_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "credential_resolver_bindings" ADD CONSTRAINT "credential_resolver_bindings_credentialId_fkey"
  FOREIGN KEY ("credentialId") REFERENCES "http_credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DO $rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['credential_resolvers', 'credential_resolver_bindings'] LOOP
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

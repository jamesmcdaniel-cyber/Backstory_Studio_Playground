CREATE TABLE "artifact_app_states" (
 "id" TEXT PRIMARY KEY,
 "organizationId" UUID NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
 "artifactId" TEXT NOT NULL REFERENCES "artifacts"("id") ON DELETE CASCADE,
 "userId" TEXT NOT NULL,
 "key" TEXT NOT NULL,
 "value" JSONB NOT NULL,
 "revision" INTEGER NOT NULL DEFAULT 1,
 "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "artifact_app_states_organizationId_artifactId_userId_key_key" UNIQUE ("organizationId", "artifactId", "userId", "key")
);
ALTER TABLE "artifact_app_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "artifact_app_states" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "artifact_app_states" USING ("organizationId" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organizationId" = nullif(current_setting('app.organization_id', true), '')::uuid);
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backstory_app') THEN GRANT SELECT, INSERT, UPDATE, DELETE ON "artifact_app_states" TO backstory_app; END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON "artifact_app_states" FROM anon; END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON "artifact_app_states" FROM authenticated; END IF;
END $$;

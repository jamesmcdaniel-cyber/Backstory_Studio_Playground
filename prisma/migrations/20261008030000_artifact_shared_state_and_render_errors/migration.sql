-- Shared application state (one value per artifact + key, for every viewer)
-- and the runtime errors a version's page reported from the viewer. Both are
-- tenant rows under the standard RLS policy, like artifact_app_states.
CREATE TABLE "artifact_shared_states" (
 "id" TEXT PRIMARY KEY,
 "organizationId" UUID NOT NULL,
 "artifactId" TEXT NOT NULL,
 "key" TEXT NOT NULL,
 "value" JSONB NOT NULL,
 "revision" INTEGER NOT NULL DEFAULT 1,
 "updatedByUserId" TEXT,
 "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "artifact_shared_states_organizationId_artifactId_key_key" UNIQUE ("organizationId", "artifactId", "key"),
 CONSTRAINT "artifact_shared_states_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "artifact_shared_states_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
ALTER TABLE "artifact_shared_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "artifact_shared_states" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "artifact_shared_states" USING ("organizationId" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organizationId" = nullif(current_setting('app.organization_id', true), '')::uuid);

CREATE TABLE "artifact_render_errors" (
 "id" TEXT PRIMARY KEY,
 "organizationId" UUID NOT NULL,
 "artifactId" TEXT NOT NULL,
 "versionId" TEXT NOT NULL,
 "userId" TEXT,
 "errors" JSONB NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "artifact_render_errors_organizationId_artifactId_versionId_key" UNIQUE ("organizationId", "artifactId", "versionId"),
 CONSTRAINT "artifact_render_errors_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "artifact_render_errors_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
ALTER TABLE "artifact_render_errors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "artifact_render_errors" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "artifact_render_errors" USING ("organizationId" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organizationId" = nullif(current_setting('app.organization_id', true), '')::uuid);

DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backstory_app') THEN
  GRANT SELECT, INSERT, UPDATE, DELETE ON "artifact_shared_states" TO backstory_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON "artifact_render_errors" TO backstory_app;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
  REVOKE ALL ON "artifact_shared_states" FROM anon;
  REVOKE ALL ON "artifact_render_errors" FROM anon;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
  REVOKE ALL ON "artifact_shared_states" FROM authenticated;
  REVOKE ALL ON "artifact_render_errors" FROM authenticated;
 END IF;
END $$;

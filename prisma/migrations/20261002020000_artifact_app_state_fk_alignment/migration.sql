-- 20261001110000 declared these foreign keys inline, without the ON UPDATE
-- CASCADE that schema.prisma's relations imply, so the database drifted from
-- the schema (the CI `migrations` job). Recreate them as the schema states.
ALTER TABLE "artifact_app_states"
  DROP CONSTRAINT "artifact_app_states_organizationId_fkey",
  DROP CONSTRAINT "artifact_app_states_artifactId_fkey";
ALTER TABLE "artifact_app_states"
  ADD CONSTRAINT "artifact_app_states_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "artifact_app_states_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

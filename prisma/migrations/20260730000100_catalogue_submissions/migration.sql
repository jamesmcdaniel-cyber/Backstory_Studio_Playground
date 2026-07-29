-- Platform tiers + the catalogue review gate.
--
-- Until now any authenticated user could set visibility='global' on a template
-- and reach every other workspace's catalogue, and every shared_skill row was
-- public by construction. These columns are what lets a review gate exist:
-- `kind`/`platformRole` say who may publish, `catalogueStatus` says whether an
-- entry was reviewed or predates review.

ALTER TABLE "organizations" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'customer';
ALTER TABLE "users" ADD COLUMN "platformRole" TEXT;

ALTER TABLE "agent_templates" ADD COLUMN "catalogueStatus" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "flow_templates"  ADD COLUMN "catalogueStatus" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "shared_skills"   ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'org';
ALTER TABLE "shared_skills"   ADD COLUMN "catalogueStatus" TEXT NOT NULL DEFAULT 'none';

-- Grandfather what is already published so the catalogue does not empty on
-- deploy. Staff audit these through the Legacy tab and retire them there.
UPDATE "agent_templates" SET "catalogueStatus" = 'legacy_published' WHERE "visibility" = 'global';
UPDATE "flow_templates"  SET "catalogueStatus" = 'legacy_published' WHERE "visibility" = 'global';
-- Every shared skill was public-by-construction before this migration.
UPDATE "shared_skills"   SET "visibility" = 'global', "catalogueStatus" = 'legacy_published';

CREATE TABLE "catalogue_submissions" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "snapshot" JSONB NOT NULL,
  "sourceId" TEXT,
  "organizationId" UUID NOT NULL,
  "submittedByUserId" TEXT NOT NULL,
  "reviewerUserId" TEXT,
  "reviewNote" TEXT,
  "decidedAt" TIMESTAMP(3),
  "publishedEntryId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "catalogue_submissions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "catalogue_submissions_status_createdAt_idx"
  ON "catalogue_submissions"("status", "createdAt");
CREATE INDEX "catalogue_submissions_organizationId_status_idx"
  ON "catalogue_submissions"("organizationId", "status");

ALTER TABLE "catalogue_submissions"
  ADD CONSTRAINT "catalogue_submissions_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

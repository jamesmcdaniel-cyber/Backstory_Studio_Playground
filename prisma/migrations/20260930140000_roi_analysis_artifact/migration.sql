-- An ROI analysis now owns its artifact from the start: the artifact page is
-- the only ROI surface, so it must exist (and show the run) before the first
-- version does. Backfill from the results of analyses that already finished.
ALTER TABLE "roi_analyses" ADD COLUMN "artifactId" TEXT;
UPDATE "roi_analyses" SET "artifactId" = "results"->>'artifactId' WHERE "results" ? 'artifactId';
CREATE INDEX "roi_analyses_organizationId_artifactId_idx" ON "roi_analyses"("organizationId", "artifactId");

-- The structured state behind a version, for kinds the platform renders
-- rather than stores verbatim (an ROI dashboard: its facts file, narrative
-- and view). Editing such an artifact edits this state and re-renders; the
-- content column still holds the rendered page each version showed.
ALTER TABLE "artifact_versions" ADD COLUMN "state" JSONB;

-- The view an ROI analysis starts from — carried over when the assistant
-- builds the same dashboard for another account.
ALTER TABLE "roi_analyses" ADD COLUMN "view" JSONB;

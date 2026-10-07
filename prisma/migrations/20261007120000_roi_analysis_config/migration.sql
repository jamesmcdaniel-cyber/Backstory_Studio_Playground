-- The ROI analysis page records how each run was configured (windows,
-- comparison, cohort type, fiscal year start) and why it was run, so run
-- history can show and compare them.
ALTER TABLE "roi_analyses" ADD COLUMN "config" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "roi_analyses" ADD COLUMN "reason" TEXT NOT NULL DEFAULT '';

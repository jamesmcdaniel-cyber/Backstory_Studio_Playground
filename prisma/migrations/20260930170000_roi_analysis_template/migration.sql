-- Which ROI analysis a row builds: the rep engagement dashboard (every row so
-- far) or the Account 360 click-stream → pipeline suite.
ALTER TABLE "roi_analyses" ADD COLUMN IF NOT EXISTS "template" TEXT NOT NULL DEFAULT 'engagement';

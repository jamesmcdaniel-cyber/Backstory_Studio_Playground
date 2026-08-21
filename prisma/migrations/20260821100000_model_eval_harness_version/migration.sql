-- Labels every existing bench/shadow row as pre-fix, and gives new rows
-- somewhere to hold the per-sample judge evidence behind their mean score.
--
-- harnessVersion defaults to 'pre-2026-08-20' (not NULL) so legacy rows —
-- including the era where live bench runs got inverted scores, fixed in
-- 4f48b3a9 — are labeled rather than silently blended into rolling averages
-- that filter on CURRENT_HARNESS_VERSION.
ALTER TABLE "model_eval_results" ADD COLUMN "harnessVersion" TEXT NOT NULL DEFAULT 'pre-2026-08-20';
ALTER TABLE "model_eval_results" ADD COLUMN "samples" JSONB;

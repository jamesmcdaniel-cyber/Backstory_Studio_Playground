-- Data-only backfill, no schema drift.
--
-- `degraded` (added 20260821090000) is computed once at finalize from the
-- FULL step set (see execute-flow.ts). Runs that finished BEFORE that
-- migration landed never had it computed and were backfilled to the column
-- default, `false` — which the UI reads as "no fine print" forever, even
-- when the run in fact failed a step or carried engine warnings. This flips
-- those legacy rows to tell the truth.
--
-- `jsonb_typeof(...) = 'array'` guards `jsonb_array_length` against any
-- non-array JSON that might be stored in `warnings` (it throws on scalars/
-- objects) rather than assuming every row already holds an array.
UPDATE "flow_runs"
SET "degraded" = true
WHERE "status" = 'succeeded'
  AND "degraded" = false
  AND EXISTS (
    SELECT 1
    FROM "flow_run_steps" s
    WHERE s."flowRunId" = "flow_runs"."id"
      AND (
        s."status" = 'failed'
        OR (
          s."warnings" IS NOT NULL
          AND jsonb_typeof(s."warnings") = 'array'
          AND jsonb_array_length(s."warnings") > 0
        )
      )
  );

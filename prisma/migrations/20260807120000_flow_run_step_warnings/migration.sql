-- Degraded-success notes per step (StepOutcome.warnings). Nullable, no backfill.
ALTER TABLE "flow_run_steps" ADD COLUMN "warnings" JSONB;

-- Per-call latency, so the Models console can report performance beside cost.
--
-- Nullable with no default on purpose: existing rows have no measurement, and a
-- 0 default would be indistinguishable from an instant call and would drag every
-- model's average latency toward zero for as long as that history is retained.
ALTER TABLE "llm_calls" ADD COLUMN "latencyMs" INTEGER;

-- The Models console and the daily Claude-usage caps both scan a time window
-- grouped by provider + model; without this they fall back to the
-- organizationId index and re-scan the whole window.
CREATE INDEX "llm_calls_provider_model_createdAt_idx" ON "llm_calls" ("provider", "model", "createdAt");

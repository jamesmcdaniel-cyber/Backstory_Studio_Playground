-- Operator user console.
--
-- Two columns, both additive and nullable, so this deploys against a live
-- database with no backfill and no downtime.
--
-- 1. llm_calls.userId — per-person token attribution. The model declares no
--    relations by design, so without this column the console can only report
--    agent-plane tokens and under-reports anyone who mostly runs flows.
--    Historical rows stay NULL; the 90-day retention sweep closes the gap.
--
-- 2. users.runAllowanceResetAt — watermark letting an operator hand someone a
--    fresh daily run allowance. The cap is counted from run rows, so it cannot
--    be decremented; moving the window start is the only honest reset.

ALTER TABLE "llm_calls" ADD COLUMN "userId" TEXT;
CREATE INDEX "llm_calls_userId_createdAt_idx" ON "llm_calls" ("userId", "createdAt");

ALTER TABLE "users" ADD COLUMN "runAllowanceResetAt" TIMESTAMPTZ(6);

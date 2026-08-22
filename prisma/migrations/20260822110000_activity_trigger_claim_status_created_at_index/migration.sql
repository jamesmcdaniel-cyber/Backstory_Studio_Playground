-- Deferred from Task 6: the 5-minute stale-claim proactive sweep
-- (countStaleActivityTriggerClaims in src/lib/queue/queue-watch.ts) counts
-- activity_trigger_claims WHERE status = 'claimed' AND "createdAt" < cutoff,
-- cross-org, every tick — currently a full table seq-scan. Additive-only
-- index, no data change.
CREATE INDEX "activity_trigger_claims_status_createdAt_idx" ON "activity_trigger_claims"("status", "createdAt");

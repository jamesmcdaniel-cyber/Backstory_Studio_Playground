-- The graph-indexing sweep (src/lib/activity/indexer-sweep.ts) queries
-- activity_events WHERE "indexedAt" IS NULL, cross-org (no organizationId
-- filter — it batches unindexed rows system-wide, INDEXER_SWEEP_BATCH_SIZE
-- at a time). The existing [organizationId, indexedAt] composite index
-- doesn't serve a query with no organizationId predicate; this partial index
-- targets exactly the sweep's own WHERE clause. Additive-only, no data change.
CREATE INDEX "activity_events_indexedAt_null_idx" ON "activity_events" ("indexedAt") WHERE "indexedAt" IS NULL;

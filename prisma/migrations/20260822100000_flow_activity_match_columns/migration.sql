-- Denormalized match index for the activity-event dispatcher (Task 6 of the
-- activity-event substrate plan). `Flow.trigger`'s JSON stays the source of
-- truth; these two columns are kept in lockstep with it by
-- `triggerFromGraph`'s write path (flow save/publish/import/template
-- instantiate) so the dispatcher can run one indexed
-- `WHERE organizationId = ? AND activitySource = ?` scan instead of decoding
-- JSON on every ACTIVE flow in the org.
ALTER TABLE "flows" ADD COLUMN "activitySource" TEXT;
ALTER TABLE "flows" ADD COLUMN "activityKinds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE INDEX "flows_organizationId_activitySource_idx" ON "flows"("organizationId", "activitySource");

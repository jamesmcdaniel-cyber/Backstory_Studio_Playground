-- Fix activity_trigger_claims.flowId/flowRunId: they shipped as UUID in
-- 20260822090000_activity_event_substrate, but Flow.id and FlowRun.id (see
-- their models) are cuids, not uuids — same class of bug as
-- activity_events.ownerUserId, fixed in 20260822093000. Caught wiring the
-- first writer that populates real values (Task 6, the dispatcher itself):
-- no claim in production has ever successfully carried a Flow's real id, so
-- this is a pure type correction, not a data migration.
ALTER TABLE "activity_trigger_claims" ALTER COLUMN "flowId" TYPE TEXT USING "flowId"::text;
ALTER TABLE "activity_trigger_claims" ALTER COLUMN "flowRunId" TYPE TEXT USING "flowRunId"::text;

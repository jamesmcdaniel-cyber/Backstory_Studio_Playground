-- Fix activity_events.ownerUserId: it shipped as UUID in
-- 20260822090000_activity_event_substrate, but User.id (what this column
-- holds — see mirror.ts's `userId: endUser?.id ?? null` and
-- NangoConnection.userId, which is a plain, non-uuid String) is a cuid, not a
-- uuid. Every real user id therefore failed to write here at all. Caught
-- while wiring the first writer that populates a non-null value (Task 3 of
-- the activity-event substrate plan, Nango ingestion) — no row in production
-- has ever successfully carried a non-null ownerUserId, so this is a pure
-- type correction, not a data migration.
ALTER TABLE "activity_events" ALTER COLUMN "ownerUserId" TYPE TEXT USING "ownerUserId"::text;

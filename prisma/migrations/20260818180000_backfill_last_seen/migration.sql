-- Seed last-seen from activity that already happened.
--
-- users."lastSeenAt" shipped in 20260609000000_den_core and the admin Users
-- table has read it ever since, but no code path ever wrote it — so every
-- account reads "Never", including accounts signing in daily. The writer now
-- exists (src/lib/server/presence.ts); without this backfill the column would
-- still read "Never" for everyone until each person's next request.
--
-- An agent run is proof its owner was here, so the most recent run per user is
-- a defensible lower bound for when they were last seen. Users with no runs
-- stay NULL and correctly read "Never" until their next request.
UPDATE users u
SET "lastSeenAt" = latest.seen
FROM (
  SELECT "userId", MAX("startedAt") AS seen
  FROM agent_executions
  GROUP BY "userId"
) AS latest
WHERE latest."userId" = u.id
  AND u."lastSeenAt" IS NULL;

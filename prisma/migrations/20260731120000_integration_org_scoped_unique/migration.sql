-- Integration: re-key the unique constraint per workspace.
--
-- It was UNIQUE(userId, provider) — global to the person. Membership is a
-- single-org FK, so a user who moved workspaces (invitation acceptance) kept a
-- row stamped with the org they LEFT, and that row occupied the only slot for
-- that provider: they could never reconnect it in the new workspace, while the
-- old workspace kept seeing the connection via [organizationId, provider].
--
-- Order matters. Backfill first, then swap the constraint — a stale duplicate
-- would otherwise fail the new index build.

-- 1. Revoke rows stranded in a workspace the user no longer belongs to. These
--    are exactly the rows the old key made unusable; the user reconnects in
--    their current workspace. Matches the runtime behaviour now enforced by
--    transferUserToOrganization (src/lib/org-transfer.ts).
DELETE FROM "integrations" i
USING "users" u
WHERE i."userId" = u."id"
  AND (u."organizationId" IS NULL OR i."organizationId" <> u."organizationId");

-- 2. Defensive dedupe. The old key was STRICTER than the new one, so with the
--    index intact this deletes nothing; it only fires on a database where the
--    unique index was dropped out of band. Keeps the most recently updated row.
DELETE FROM "integrations" a
USING "integrations" b
WHERE a."organizationId" = b."organizationId"
  AND a."userId" = b."userId"
  AND a."provider" = b."provider"
  AND (a."updatedAt", a."id") < (b."updatedAt", b."id");

-- 3. Swap the constraint.
DROP INDEX IF EXISTS "integrations_userId_provider_key";

CREATE UNIQUE INDEX "integrations_organizationId_userId_provider_key"
  ON "integrations" ("organizationId", "userId", "provider");

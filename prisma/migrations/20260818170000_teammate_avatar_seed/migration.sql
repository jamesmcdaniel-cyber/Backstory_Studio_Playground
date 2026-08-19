-- Choosable avatars.
--
-- The face is derived from a seed string rather than stored as an image, so
-- picking a different look is just recording a different seed. Null keeps the
-- row id as the seed, which is exactly what every existing avatar already uses
-- — so this is additive and no row needs backfilling.
--
-- Agents carry the same setting in their metadata JSON (see AgentMetadata
-- .avatarSeed); only teammates need a column, because they have no metadata bag.

ALTER TABLE "agent_teammates" ADD COLUMN "avatarSeed" TEXT;

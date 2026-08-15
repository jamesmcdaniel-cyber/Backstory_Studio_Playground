-- Record the scopes a provider actually granted.
--
-- Until now the granted scope was parsed out of the token response and
-- discarded, so a connection that asked for read-only and one that asked for
-- full write access produced byte-identical rows. That made "are OAuth scopes
-- minimized?" unanswerable for every integration in the platform.
--
-- Defaulted to an empty array rather than backfilled: we genuinely do not know
-- what existing connections were granted, and inventing a value would make the
-- review surface confidently wrong. An empty array reads as "not recorded",
-- which is the truth, and each connection fills in on its next re-authorization.

ALTER TABLE "mcp_connections"
  ADD COLUMN "grantedScopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "nango_connections"
  ADD COLUMN "grantedScopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "people_ai_connections"
  ADD COLUMN "grantedScopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Give HTTP credentials an owner.
--
-- http_credentials had no userId column at all: every credential was
-- workspace-wide, so any agent in the org could authenticate as it and no
-- action taken with it was attributable to a person. That is the "shared human
-- credentials" finding, and it is the one an offboarding cannot clean up —
-- revokeUserAccess deletes what a departing person owned, and this table owned
-- nothing by anyone.
--
-- Existing rows keep userId = NULL, meaning "legacy workspace-shared". NOT
-- backfilled to a guessed owner: attributing a credential to whoever happens to
-- have created the row would put someone's name on actions they may never have
-- taken, which is worse than an honest null. The credentials page flags them
-- for a human to claim or replace.
--
-- ON DELETE CASCADE, not SET NULL: null MEANS org-shared here, so nulling a
-- departed person's row would silently promote their personal credential into
-- one the whole workspace can use.

ALTER TABLE "http_credentials" ADD COLUMN "userId" TEXT;

ALTER TABLE "http_credentials"
  ADD CONSTRAINT "http_credentials_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "http_credentials_userId_idx" ON "http_credentials"("userId");

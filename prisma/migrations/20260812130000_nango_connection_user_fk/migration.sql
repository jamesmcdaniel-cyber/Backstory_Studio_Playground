-- NangoConnection.userId was a dangling column: no relation, no foreign key.
-- Nothing guaranteed it named a real user, and it could not be joined — which
-- is why the owner-liveness guard could not filter this table.

-- Orphans first, or the constraint cannot be created. A row whose owner no
-- longer exists is an UNATTRIBUTABLE credential pointer, which is precisely what
-- the revocation work exists to eliminate, so deleting is the correct repair
-- rather than a data loss. These rows are a mirror of Nango's state:
-- syncOrgNangoConnections rebuilds any row that still has a live owner.
--
-- Deliberately NOT `SET userId = NULL`: null MEANS org-shared here, so nulling
-- an orphan would promote a departed person's personal connection into one the
-- entire workspace can use.
DELETE FROM "nango_connections"
WHERE "userId" IS NOT NULL
  AND "userId" NOT IN (SELECT "id" FROM "users");

-- Cascade for the same reason: a personal connection dies with its owner.
ALTER TABLE "nango_connections"
  ADD CONSTRAINT "nango_connections_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "nango_connections_userId_idx" ON "nango_connections" ("userId");

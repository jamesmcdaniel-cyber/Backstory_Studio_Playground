-- Demo mode: a demo org is a disposable anonymised copy of a real workspace.
-- Both columns are null for every real workspace; the unique index doubles as
-- the "one demo workspace per person" invariant (reused across sessions,
-- deleted on exit).
ALTER TABLE "organizations" ADD COLUMN "demoOfOrganizationId" UUID;
ALTER TABLE "organizations" ADD COLUMN "demoOwnerUserId" TEXT;
CREATE UNIQUE INDEX "organizations_demoOwnerUserId_key" ON "organizations"("demoOwnerUserId");

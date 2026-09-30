-- Artifact sharing: workspace access level, named editors, and an opt-in
-- view-only public link (token stored as a digest for lookup, encrypted so
-- editors can copy it again).
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "workspaceAccess" TEXT NOT NULL DEFAULT 'edit';
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "editorIds" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "shareAnonymous" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "shareTokenDigest" TEXT;
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "shareTokenCiphertext" TEXT;
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "anonymousViews" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS "artifacts_shareTokenDigest_key" ON "artifacts"("shareTokenDigest");

-- Promote agent knowledge uploads into a workspace content repository. The
-- existing tables retain their ids and RLS policies, so deployed agents keep
-- resolving the same chunks throughout the migration window.
ALTER TABLE "knowledge_documents"
  ADD COLUMN "description" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "content" TEXT,
  ADD COLUMN "storedFileId" TEXT,
  ADD COLUMN "assetType" TEXT NOT NULL DEFAULT 'file',
  ADD COLUMN "sourceType" TEXT NOT NULL DEFAULT 'upload',
  ADD COLUMN "sourceProvider" TEXT,
  ADD COLUMN "sourceConnectionId" TEXT,
  ADD COLUMN "sourceTool" TEXT,
  ADD COLUMN "sourceMetadata" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "isEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "lastSyncedAt" TIMESTAMPTZ,
  ADD COLUMN "updatedAt" TIMESTAMP(3);

-- Older uploads did not retain canonical text. Reconstruct an editable form
-- from ordered chunks. Overlap between legacy chunks is preferable to leaving
-- those assets uneditable; the first edit rewrites a clean chunk set.
UPDATE "knowledge_documents" AS d
SET "content" = indexed."content"
FROM (
  SELECT "documentId", string_agg("content", E'\n\n' ORDER BY "ordinal") AS "content"
  FROM "knowledge_chunks"
  GROUP BY "documentId"
) AS indexed
WHERE indexed."documentId" = d."id" AND d."content" IS NULL;

-- Prisma's @updatedAt is application-managed (no database default). Existing
-- rows take their creation time, then the column becomes required.
UPDATE "knowledge_documents"
SET "updatedAt" = "createdAt"
WHERE "updatedAt" IS NULL;
ALTER TABLE "knowledge_documents" ALTER COLUMN "updatedAt" SET NOT NULL;

CREATE UNIQUE INDEX "knowledge_documents_storedFileId_key"
  ON "knowledge_documents"("storedFileId");
CREATE INDEX "knowledge_documents_organizationId_isEnabled_updatedAt_idx"
  ON "knowledge_documents"("organizationId", "isEnabled", "updatedAt");
CREATE INDEX "knowledge_documents_organizationId_sourceType_updatedAt_idx"
  ON "knowledge_documents"("organizationId", "sourceType", "updatedAt");
CREATE INDEX "knowledge_documents_organizationId_sourceProvider_lastSynce_idx"
  ON "knowledge_documents"("organizationId", "sourceProvider", "lastSyncedAt");

ALTER TABLE "knowledge_documents"
  ADD CONSTRAINT "knowledge_documents_assetType_check"
    CHECK ("assetType" IN ('file', 'pull_artifact', 'note')),
  ADD CONSTRAINT "knowledge_documents_sourceType_check"
    CHECK ("sourceType" IN ('upload', 'integration', 'manual')),
  ADD CONSTRAINT "knowledge_documents_status_check"
    CHECK ("status" IN ('ready', 'processing', 'failed')),
  ADD CONSTRAINT "knowledge_documents_counts_check"
    CHECK ("sizeBytes" >= 0 AND "charCount" >= 0 AND "version" > 0),
  ADD CONSTRAINT "knowledge_documents_sourceMetadata_object_check"
    CHECK (jsonb_typeof("sourceMetadata") = 'object'),
  ADD CONSTRAINT "knowledge_documents_storedFileId_fkey"
  FOREIGN KEY ("storedFileId") REFERENCES "stored_files"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

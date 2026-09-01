ALTER TABLE "knowledge_documents"
  ADD COLUMN "indexState" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "indexError" TEXT,
  ADD COLUMN "truncated" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "knowledge_documents_organizationId_indexState_idx"
  ON "knowledge_documents" ("organizationId", "indexState");

-- Backfill from the chunks that already exist, so the first sweep only has to
-- fix genuinely broken documents rather than re-derive the whole table.
UPDATE "knowledge_documents" d SET "indexState" = CASE
  WHEN NOT EXISTS (SELECT 1 FROM "knowledge_chunks" c WHERE c."documentId" = d."id")
    THEN 'pending'
  WHEN NOT EXISTS (SELECT 1 FROM "knowledge_chunks" c WHERE c."documentId" = d."id" AND c."embeddingVec" IS NOT NULL)
    THEN 'unindexed'
  WHEN EXISTS (SELECT 1 FROM "knowledge_chunks" c WHERE c."documentId" = d."id" AND c."embeddingVec" IS NULL)
    THEN 'partial'
  ELSE 'indexed'
END;

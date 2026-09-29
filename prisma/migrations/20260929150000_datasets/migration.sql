-- Datasets: tabular files the platform stores whole and computes over.
--
-- 1. A stored file can now be "pending": the row (and its quota reservation)
--    exists while the browser uploads the bytes straight to object storage,
--    and only becomes "ready" once the server has verified what landed.
-- 2. Repository assets gain the 'dataset' kind — a CSV/TSV kept intact in
--    StoredFile with only its profile (columns, types, row count, samples)
--    indexed, instead of its first 200K characters.
ALTER TABLE "stored_files"
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ready';

ALTER TABLE "knowledge_documents"
  DROP CONSTRAINT IF EXISTS "knowledge_documents_assetType_check";

ALTER TABLE "knowledge_documents"
  ADD CONSTRAINT "knowledge_documents_assetType_check"
    CHECK ("assetType" IN ('file', 'pull_artifact', 'note', 'project', 'synced_file', 'dataset'));

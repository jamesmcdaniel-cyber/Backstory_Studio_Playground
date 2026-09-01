-- The original content-repository migration (20260828120000) constrained
-- assetType to file | pull_artifact | note. Two more kinds were added to the
-- schema and the code afterwards — 'project' (editable Markdown references)
-- and 'synced_file' (GitHub sync) — but the CHECK was never widened, so both
-- "Save a project" and every GitHub sync fail at the database with a 23514.
-- Widen it to the set the schema documents.
ALTER TABLE "knowledge_documents"
  DROP CONSTRAINT IF EXISTS "knowledge_documents_assetType_check";

ALTER TABLE "knowledge_documents"
  ADD CONSTRAINT "knowledge_documents_assetType_check"
    CHECK ("assetType" IN ('file', 'pull_artifact', 'note', 'project', 'synced_file'));

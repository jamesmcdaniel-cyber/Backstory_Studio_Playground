-- Stable synchronization identities make repeated/concurrent GitHub imports
-- idempotent without exposing repository paths in an indexed key.
ALTER TABLE "knowledge_documents"
  ADD COLUMN "sourceKey" TEXT,
  ADD COLUMN "sourceGroupKey" TEXT;

CREATE UNIQUE INDEX "knowledge_documents_organizationId_sourceKey_key"
  ON "knowledge_documents"("organizationId", "sourceKey");

CREATE INDEX "knowledge_documents_organizationId_sourceGroupKey_idx"
  ON "knowledge_documents"("organizationId", "sourceGroupKey");

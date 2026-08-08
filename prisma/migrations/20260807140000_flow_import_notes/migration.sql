-- Persisted import report ({notes, blocking}). Nullable, no backfill.
ALTER TABLE "flows" ADD COLUMN "importNotes" JSONB;

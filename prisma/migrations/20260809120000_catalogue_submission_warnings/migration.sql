-- Submit-time secret-scan findings, shown to the reviewer. Nullable: rows that
-- predate the scan have no findings rather than an empty-array claim that they
-- were scanned and came back clean.
ALTER TABLE "catalogue_submissions" ADD COLUMN "warnings" JSONB;

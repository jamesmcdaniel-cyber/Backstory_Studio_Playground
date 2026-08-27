ALTER TABLE "flow_runs"
  ADD COLUMN "annotation" TEXT,
  ADD COLUMN "rating" INTEGER,
  ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "customMetadata" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "annotatedByUserId" TEXT,
  ADD COLUMN "annotatedAt" TIMESTAMP(3),
  ADD CONSTRAINT "flow_runs_rating_check" CHECK ("rating" IS NULL OR "rating" BETWEEN 1 AND 5),
  ADD CONSTRAINT "flow_runs_tags_count_check" CHECK (cardinality("tags") <= 20),
  ADD CONSTRAINT "flow_runs_metadata_object_check" CHECK (jsonb_typeof("customMetadata") = 'object');

CREATE INDEX "flow_runs_organizationId_rating_startedAt_idx"
  ON "flow_runs"("organizationId", "rating", "startedAt");
CREATE INDEX "flow_runs_tags_gin_idx" ON "flow_runs" USING GIN ("tags");
CREATE INDEX "flow_runs_customMetadata_gin_idx" ON "flow_runs" USING GIN ("customMetadata");

ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_annotatedByUserId_fkey"
  FOREIGN KEY ("annotatedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

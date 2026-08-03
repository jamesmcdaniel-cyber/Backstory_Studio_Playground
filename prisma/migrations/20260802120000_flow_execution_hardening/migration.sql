ALTER TABLE "flow_runs" ADD COLUMN "executionManifest" JSONB;
ALTER TABLE "organizations" ADD COLUMN "storageBytes" BIGINT NOT NULL DEFAULT 0;
UPDATE "organizations" o SET "storageBytes" = COALESCE((
  SELECT SUM(sf."size") FROM "stored_files" sf WHERE sf."organizationId" = o."id"
), 0);
ALTER TABLE "mcp_connections"
  ADD COLUMN "healthStatus" TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN "lastError" TEXT,
  ADD COLUMN "toolSchemaHash" TEXT;

CREATE TABLE "flow_webhook_receipts" (
  "id" TEXT NOT NULL,
  "flowId" TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "deliveryId" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "flowRunId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'processing',
  "lastError" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "flow_webhook_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "flow_webhook_receipts_flowId_deliveryId_key"
  ON "flow_webhook_receipts"("flowId", "deliveryId");
CREATE INDEX "flow_webhook_receipts_expiresAt_idx"
  ON "flow_webhook_receipts"("expiresAt");
CREATE INDEX "flow_webhook_receipts_organizationId_receivedAt_idx"
  ON "flow_webhook_receipts"("organizationId", "receivedAt");

ALTER TABLE "flow_webhook_receipts"
  ADD CONSTRAINT "flow_webhook_receipts_flowId_fkey"
  FOREIGN KEY ("flowId") REFERENCES "flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "flow_webhook_receipts"
  ADD CONSTRAINT "flow_webhook_receipts_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "outbox_events" (
  "id" TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "topic" TEXT NOT NULL,
  "aggregateId" TEXT,
  "dedupeKey" TEXT,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMPTZ(6),
  "lastError" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deliveredAt" TIMESTAMPTZ(6),
  CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "outbox_events_organizationId_dedupeKey_key" ON "outbox_events"("organizationId", "dedupeKey");
CREATE INDEX "outbox_events_status_availableAt_idx" ON "outbox_events"("status", "availableAt");
CREATE INDEX "outbox_events_organizationId_createdAt_idx" ON "outbox_events"("organizationId", "createdAt");
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

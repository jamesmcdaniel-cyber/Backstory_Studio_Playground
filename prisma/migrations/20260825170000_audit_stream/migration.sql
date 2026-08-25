-- Forward the audit trail to a customer's own system.
--
-- The trail has always been complete; it lived only in our database, so
-- answering "show us your logs in OUR SIEM" meant exporting by hand. This is
-- the destination config; delivery rides the existing outbox, which already has
-- claiming, backoff and a retry ceiling. An audit event dropped because a
-- customer's endpoint was down for an hour is the one kind of gap that matters,
-- and the outbox is what prevents it.
--
-- The URL is caller-supplied and our server posts to it, so it is HTTPS-only
-- and SSRF-guarded on save AND on every delivery. The secret is encrypted at
-- rest like every other credential and signs each delivery, so a receiver can
-- tell our POST from anyone else who learns the URL.
CREATE TABLE "audit_stream_destinations" (
  "id"              TEXT NOT NULL,
  "organizationId"  UUID NOT NULL,
  "name"            TEXT NOT NULL,
  "url"             TEXT NOT NULL,
  "secret"          TEXT,
  "actionPrefixes"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "isActive"        BOOLEAN NOT NULL DEFAULT true,
  "lastDeliveredAt" TIMESTAMPTZ(6),
  "lastError"       TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "audit_stream_destinations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_stream_destinations_organizationId_isActive_idx"
  ON "audit_stream_destinations" ("organizationId", "isActive");

ALTER TABLE "audit_stream_destinations" ADD CONSTRAINT "audit_stream_destinations_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

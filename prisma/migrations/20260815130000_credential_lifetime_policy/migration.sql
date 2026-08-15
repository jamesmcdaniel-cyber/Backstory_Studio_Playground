-- Rotation age and optional expiry for stored third-party secrets.
--
-- Expiry was optional at mint for every long-lived credential here, so a key
-- minted once stayed valid until someone remembered it existed — and nothing
-- surfaced that it existed, so nobody did. Rotation was always *possible*;
-- what was missing was anything making it happen.
--
-- lastRotatedAt is left NULL rather than backfilled to createdAt. NULL means
-- "never rotated since creation", which is exactly what is true of every
-- existing row, and assessStaleness already falls back to createdAt for it.
-- Backfilling would assert a rotation that never occurred.

ALTER TABLE "http_credentials"
  ADD COLUMN "lastRotatedAt" TIMESTAMP(3),
  ADD COLUMN "expiresAt" TIMESTAMP(3);

ALTER TABLE "integration_secrets"
  ADD COLUMN "lastRotatedAt" TIMESTAMP(3),
  ADD COLUMN "expiresAt" TIMESTAMP(3);

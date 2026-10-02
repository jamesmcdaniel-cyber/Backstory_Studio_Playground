-- When an artifact's public link stops working, set by whoever shares it.
-- NULL = it never expires (how every existing link behaves).
ALTER TABLE "artifacts" ADD COLUMN "shareExpiresAt" TIMESTAMP(3);

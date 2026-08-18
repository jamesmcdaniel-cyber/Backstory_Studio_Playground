-- Flow share tokens: digest at rest.
--
-- `flows.shareToken` held the bearer credential itself. That token opens a flow
-- from another workspace, or — with shareAnonymous — with no session at all,
-- and it does not expire, so a database read (a backup, a support query, a
-- replica, an export) handed out live access to every shared flow.
--
-- Same shape as every other bearer value in the schema (ScimToken.tokenHash,
-- Invitation.tokenHash, ApiKey.keyHash): store the SHA-256 digest, show the raw
-- token once at mint, and resolve later presentations by hashing what the
-- caller sent. Token entropy is unchanged (16 random bytes).
--
-- Forward-only and non-destructive to access: every existing token keeps
-- working, because its digest is computed here from the plaintext before the
-- plaintext column is dropped. `sha256()` and `encode()` are core Postgres (11+)
-- built-ins, so this needs no extension — pgcrypto is not enabled on this
-- database and requiring it would make the migration fail on deploy.

ALTER TABLE "public"."flows" ADD COLUMN "shareTokenDigest" TEXT;

-- Backfill: hex SHA-256, byte-for-byte what hashToken() in
-- src/lib/crypto/secrets.ts produces, so links already in circulation resolve.
UPDATE "public"."flows"
SET "shareTokenDigest" = encode(sha256(convert_to("shareToken", 'UTF8')), 'hex')
WHERE "shareToken" IS NOT NULL;

DROP INDEX IF EXISTS "public"."flows_shareToken_key";

ALTER TABLE "public"."flows" DROP COLUMN "shareToken";

CREATE UNIQUE INDEX "flows_shareTokenDigest_key" ON "public"."flows"("shareTokenDigest");

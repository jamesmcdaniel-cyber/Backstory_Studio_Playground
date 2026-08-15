-- Client-credentials pairs and short-lived access tokens for the public API.
--
-- The public API took a single long-lived bearer token. That token was the
-- credential AND the identifier, so identifying a key in a support
-- conversation meant pasting the secret, and every request carried a value
-- valid until someone revoked it by hand.
--
-- clientId is the public half: safe to display, log and quote. It is NULL on
-- existing keys, which keep authenticating with their bearer token exactly as
-- before — this migration takes nothing away.
--
-- api_access_tokens are stored and hashed rather than signed and stateless,
-- because a stateless token cannot be revoked before it expires, and immediate
-- revocation is the property the rest of the credential system is built on.

ALTER TABLE "api_keys" ADD COLUMN "clientId" TEXT;
CREATE UNIQUE INDEX "api_keys_clientId_key" ON "api_keys"("clientId");

CREATE TABLE "api_access_tokens" (
  "id"             TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "apiKeyId"       TEXT NOT NULL,
  "tokenHash"      TEXT NOT NULL,
  "scopes"         JSONB NOT NULL DEFAULT '[]',
  "expiresAt"      TIMESTAMPTZ(6) NOT NULL,
  "revokedAt"      TIMESTAMPTZ(6),
  "lastUsedAt"     TIMESTAMPTZ(6),
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "api_access_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "api_access_tokens_tokenHash_key" ON "api_access_tokens"("tokenHash");
CREATE INDEX "api_access_tokens_apiKeyId_revokedAt_idx" ON "api_access_tokens"("apiKeyId", "revokedAt");
-- Supports the expiry sweep without a sequential scan as the table grows.
CREATE INDEX "api_access_tokens_expiresAt_idx" ON "api_access_tokens"("expiresAt");

ALTER TABLE "api_access_tokens"
  ADD CONSTRAINT "api_access_tokens_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CASCADE: revoking or deleting the key must take every token minted from it,
-- or revocation would be advisory for as long as a live token remains.
ALTER TABLE "api_access_tokens"
  ADD CONSTRAINT "api_access_tokens_apiKeyId_fkey"
  FOREIGN KEY ("apiKeyId") REFERENCES "api_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

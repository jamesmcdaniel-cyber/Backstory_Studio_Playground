ALTER TABLE "organizations"
  ADD COLUMN "mfaPolicy" TEXT NOT NULL DEFAULT 'optional',
  ADD COLUMN "ssoEnforced" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "users" ADD COLUMN "scimExternalId" TEXT;
CREATE UNIQUE INDEX "users_organizationId_scimExternalId_key"
  ON "users"("organizationId", "scimExternalId");

CREATE TABLE "organization_domains" (
  "id" TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "domain" TEXT NOT NULL,
  "verificationTokenHash" TEXT NOT NULL,
  "verificationToken" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "verifiedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "organization_domains_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organization_domains_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "organization_domains_domain_key" ON "organization_domains"("domain");
CREATE INDEX "organization_domains_organizationId_status_idx" ON "organization_domains"("organizationId", "status");

CREATE TABLE "scim_tokens" (
  "id" TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "prefix" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "lastUsedAt" TIMESTAMPTZ(6),
  "expiresAt" TIMESTAMPTZ(6),
  "revokedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "scim_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "scim_tokens_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "scim_tokens_tokenHash_key" ON "scim_tokens"("tokenHash");
CREATE INDEX "scim_tokens_organizationId_revokedAt_idx" ON "scim_tokens"("organizationId", "revokedAt");

CREATE TABLE "api_keys" (
  "id" TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "userId" TEXT,
  "name" TEXT NOT NULL,
  "keyHash" TEXT NOT NULL,
  "prefix" TEXT NOT NULL,
  "scopes" JSONB NOT NULL DEFAULT '[]',
  "lastUsedAt" TIMESTAMPTZ(6),
  "expiresAt" TIMESTAMPTZ(6),
  "revokedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "api_keys_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "api_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "api_keys_keyHash_key" ON "api_keys"("keyHash");
CREATE INDEX "api_keys_organizationId_revokedAt_idx" ON "api_keys"("organizationId", "revokedAt");

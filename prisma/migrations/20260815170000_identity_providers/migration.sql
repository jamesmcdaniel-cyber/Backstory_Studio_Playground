-- Customer-owned identity providers, and per-workspace SSO enforcement.
--
-- Okta is the platform's own IdP, but a customer reaching the platform as an
-- external delivery surface brings their own. The SAML/OIDC connection lives in
-- Supabase, which brokers the protocol; these rows record WHICH provider serves
-- which workspace so the mapping is manageable, auditable and enforceable from
-- inside the product rather than only from a Supabase dashboard.
--
-- ssoEnforcement defaults to 'optional' so turning it on is always deliberate.
-- A default of 'required' would lock every existing workspace out on deploy.

CREATE TABLE "identity_providers" (
  "id"             TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "name"           TEXT NOT NULL,
  "protocol"       TEXT NOT NULL DEFAULT 'saml',
  "supabaseSsoId"  TEXT,
  "issuer"         TEXT,
  "status"         TEXT NOT NULL DEFAULT 'pending',
  "createdById"    TEXT,
  "lastUsedAt"     TIMESTAMPTZ(6),
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "identity_providers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "identity_providers_supabaseSsoId_key" ON "identity_providers"("supabaseSsoId");
CREATE INDEX "identity_providers_organizationId_status_idx" ON "identity_providers"("organizationId", "status");

ALTER TABLE "identity_providers"
  ADD CONSTRAINT "identity_providers_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "organization_domains" ADD COLUMN "identityProviderId" TEXT;
CREATE INDEX "organization_domains_identityProviderId_idx" ON "organization_domains"("identityProviderId");

-- SET NULL, not CASCADE: removing an IdP must not delete the customer's
-- verified domain. That would silently un-verify their whole workspace, which
-- is much harder to recover from than re-pointing the domain at another IdP.
ALTER TABLE "organization_domains"
  ADD CONSTRAINT "organization_domains_identityProviderId_fkey"
  FOREIGN KEY ("identityProviderId") REFERENCES "identity_providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "organizations" ADD COLUMN "ssoEnforcement" TEXT NOT NULL DEFAULT 'optional';

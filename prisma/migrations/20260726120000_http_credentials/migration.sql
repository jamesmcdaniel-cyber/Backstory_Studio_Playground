CREATE TABLE "http_credentials" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "authType" TEXT NOT NULL,
    "allowedHost" TEXT NOT NULL,
    "secretConfig" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'verified',
    "lastVerifiedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "http_credentials_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "http_credentials_organizationId_authType_allowedHost_idx"
ON "http_credentials"("organizationId", "authType", "allowedHost");

ALTER TABLE "http_credentials"
ADD CONSTRAINT "http_credentials_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

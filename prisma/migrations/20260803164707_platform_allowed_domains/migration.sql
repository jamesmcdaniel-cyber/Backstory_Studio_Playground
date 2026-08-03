-- CreateTable
CREATE TABLE "platform_allowed_domains" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "addedByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabledAt" TIMESTAMPTZ(6),

    CONSTRAINT "platform_allowed_domains_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_allowed_domains_domain_key" ON "platform_allowed_domains"("domain");

-- CreateIndex
CREATE INDEX "platform_allowed_domains_organizationId_idx" ON "platform_allowed_domains"("organizationId");

-- AddForeignKey
ALTER TABLE "platform_allowed_domains" ADD CONSTRAINT "platform_allowed_domains_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "platform_staff_emails" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "addedByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMPTZ(6),
    "claimedByUserId" TEXT,

    CONSTRAINT "platform_staff_emails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_staff_emails_email_key" ON "platform_staff_emails"("email");

-- platform_staff_emails is a PLATFORM table, not a tenant table: a row grants
-- catalogue-review (super admin) rights platform-wide, so no tenant may read
-- or write it. Every legitimate access is through systemPrisma (BYPASSRLS):
-- administration is gated on catalogue.review, and the claim happens during
-- pre-membership provisioning. Same posture as platform_allowed_domains.
ALTER TABLE platform_staff_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_staff_emails FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_no_access ON platform_staff_emails
  USING (false)
  WITH CHECK (false);

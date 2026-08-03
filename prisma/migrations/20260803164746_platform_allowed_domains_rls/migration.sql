-- platform_allowed_domains is a PLATFORM table, not a tenant table. Its
-- "organizationId" names the workspace domain members JOIN — it is not the row's
-- owner, so the usual tenant_isolation policy would be exactly backwards: it
-- would let a customer admin read and rewrite their own access grant.
--
-- Every legitimate access is through systemPrisma (the BYPASSRLS role): the
-- sign-in gate runs before any org context exists, and administration is gated
-- on catalogue.review. So the tenant role gets no access at all.
ALTER TABLE platform_allowed_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_allowed_domains FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_no_access ON platform_allowed_domains
  USING (false)
  WITH CHECK (false);

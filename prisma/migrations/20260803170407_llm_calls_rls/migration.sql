-- llm_calls is tenant data (a workspace's own model spend), so it gets the
-- standard tenant_isolation policy matching every other org-scoped table.
-- Writes come from systemPrisma in the worker (best-effort, outside any request
-- org context); reads are admin-only via systemPrisma. The policy is
-- defense-in-depth for any future guarded-client access.
ALTER TABLE llm_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON llm_calls
  USING ("organizationId" = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK ("organizationId" = nullif(current_setting('app.organization_id', true), '')::uuid);

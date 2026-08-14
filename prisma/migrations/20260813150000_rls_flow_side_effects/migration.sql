-- flow_side_effects was missing its tenant isolation policy.
--
-- The table was created by 20260811191539_flow_side_effects, nine days AFTER
-- 20260802170000_tenant_row_level_security enumerated the tenant tables by hand.
-- Nothing connected the two, so the table shipped with RLS disabled while being
-- a required-organizationId model — meaning the tenant guard routes its queries
-- through the RLS path and sets app.organization_id, and PostgreSQL then
-- enforces nothing. A protection the application believes it has.
--
-- Second-order risk this also removes: enabling RLS on the table later WITHOUT
-- adding a policy is deny-all, because PostgreSQL's default with RLS on and no
-- matching policy is to return no rows.
--
-- src/lib/__tests__/rls-coverage.db.test.ts now fails when an org-scoped model's
-- table lacks RLS or a policy, so the next table added after an RLS migration
-- cannot repeat this silently.

ALTER TABLE flow_side_effects ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_side_effects FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON flow_side_effects;
CREATE POLICY tenant_isolation ON flow_side_effects
  USING ("organizationId" = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK ("organizationId" = nullif(current_setting('app.organization_id', true), '')::uuid);

-- Four org-scoped tables shipped without tenant isolation.
--
-- teams, feature_grants (20260815180000_teams_and_feature_grants),
-- identity_providers (20260815170000_identity_providers) and api_access_tokens
-- (20260815150000_api_client_credentials) were all created AFTER
-- 20260802170000_tenant_row_level_security enumerated the tenant tables by
-- hand. Nothing connected the two, so each shipped with RLS disabled while
-- being a required-organizationId model — the tenant guard routes their
-- queries through the RLS path and sets app.organization_id, and PostgreSQL
-- then enforces nothing. This is the same defect class as
-- 20260813150000_rls_flow_side_effects, and two of these tables are the
-- sensitive ones: api_access_tokens holds hashed API client credentials and
-- identity_providers holds SSO configuration.
--
-- Second-order risk this also removes: enabling RLS on a table later WITHOUT
-- adding a policy is deny-all, because PostgreSQL's default with RLS on and no
-- matching policy is to return no rows.
--
-- src/lib/__tests__/rls-coverage.db.test.ts fails when an org-scoped model's
-- table lacks RLS or a policy, so the next table added after an RLS migration
-- cannot repeat this silently.

DO $rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['teams','feature_grants','identity_providers','api_access_tokens'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("organizationId" = nullif(current_setting(''app.organization_id'', true), '''')::uuid) WITH CHECK ("organizationId" = nullif(current_setting(''app.organization_id'', true), '''')::uuid)',
      table_name
    );

    -- The RLS-constrained application role needs ordinary table privileges; the
    -- policy above is what limits those privileges to the active organization.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backstory_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO backstory_app', table_name);
    END IF;

    -- These tables are server-only like the rest of the Prisma application schema.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon', table_name);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM authenticated', table_name);
    END IF;
  END LOOP;
END
$rls$;

-- team_members carries its tenant ownership through its required parent team,
-- the same shape flow_collaborators uses for flows. Without this, enabling RLS
-- on teams alone would leave the membership rows readable across tenants.
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON team_members;
CREATE POLICY tenant_isolation ON team_members
  USING (EXISTS (SELECT 1 FROM teams t WHERE t.id = "teamId" AND t."organizationId" = nullif(current_setting('app.organization_id', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM teams t WHERE t.id = "teamId" AND t."organizationId" = nullif(current_setting('app.organization_id', true), '')::uuid));

DO $team_members$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backstory_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE team_members TO backstory_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE team_members FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE team_members FROM authenticated;
  END IF;
END
$team_members$;

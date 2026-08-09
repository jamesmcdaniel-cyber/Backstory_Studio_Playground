-- users and organizations had RLS enabled out-of-band (Supabase dashboard)
-- with zero policies. Non-forced RLS lets the table owner (postgres) through,
-- but the non-owner app role from the prisma.ts role split (backstory_app) is
-- default-denied — which would break sign-in. Both are deliberately non-tenant
-- tables (excluded from 20260802170000_tenant_row_level_security), so the app
-- role gets explicit full access while PostgREST's anon/authenticated roles
-- stay locked out. The role is created NOLOGIN when absent (CI, fresh DBs).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'backstory_app') THEN
    CREATE ROLE backstory_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
END
$$;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_role_access ON users;
CREATE POLICY app_role_access ON users FOR ALL TO backstory_app USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS app_role_access ON organizations;
CREATE POLICY app_role_access ON organizations FOR ALL TO backstory_app USING (true) WITH CHECK (true);

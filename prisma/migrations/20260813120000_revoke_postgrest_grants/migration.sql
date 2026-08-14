-- Close the PostgREST data-API surface on the application schema.
--
-- NEXT_PUBLIC_SUPABASE_ANON_KEY ships in the browser bundle — that is correct
-- and by design, but it is only safe while the `anon` and `authenticated` roles
-- it maps to cannot read application tables. Supabase's project defaults grant
-- table privileges to both roles on objects created in `public`, and Prisma
-- creates every one of our ~60 tables there. With DATABASE_RLS_ENABLED=false
-- (the current production state) there are no row policies standing behind
-- those grants, so any holder of the published anon key could have read every
-- workspace's rows over https://<project>.supabase.co/rest/v1/<table>.
--
-- Nothing in the product needs those grants. The Supabase JS client is used for
-- Auth and Realtime ONLY — there is no `supabase.from(...)` call anywhere in
-- src/. All data access goes through Prisma on DATABASE_URL/SYSTEM_DATABASE_URL.
--
-- Deliberately still working after this migration:
--   * Realtime broadcast/presence (flow jam, run ticks) — rides
--     realtime.messages policies, not public-schema table grants, and the app
--     uses broadcast/presence only (no postgres_changes replication).
--   * public.flow_topic_access(text) — SECURITY DEFINER, so it reads users /
--     flows / flow_collaborators as its owner. Its EXECUTE grant to
--     `authenticated` is re-issued below, after the blanket function revoke.
--   * public.handle_new_user() — SECURITY DEFINER trigger on auth.users.
--   * Supabase Storage — separate `storage` schema, reached with the service
--     role key from the server (src/lib/files/storage.ts).
--
-- Idempotent and safe on a plain PostgreSQL (CI, local repro), where the anon /
-- authenticated roles simply do not exist.

DO $$
DECLARE
  target_role text;
  creator_role text;
BEGIN
  FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
      RAISE NOTICE 'role % absent — skipping (expected outside Supabase)', target_role;
      CONTINUE;
    END IF;

    -- Existing objects.
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', target_role);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', target_role);
    EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', target_role);
    -- USAGE on the schema stays: without it the SECURITY DEFINER functions
    -- above are unreachable by name. USAGE alone confers no data access.

    -- Future objects. Default privileges are recorded per creating role, so the
    -- revoke has to name every role that runs migrations or creates tables —
    -- otherwise the next `prisma migrate deploy` re-grants what we just removed.
    FOR creator_role IN
      SELECT rolname FROM pg_roles
      WHERE rolname IN ('postgres', 'supabase_admin', 'supabase_migration', current_user)
    LOOP
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM %I',
        creator_role, target_role);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I',
        creator_role, target_role);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I',
        creator_role, target_role);
    END LOOP;
  END LOOP;
END
$$;

-- Re-issue the one EXECUTE grant the jam channel authorization depends on. The
-- blanket function revoke above is intentionally broad, so this has to come
-- after it rather than being carved out of it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     AND EXISTS (
       SELECT 1 FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'flow_topic_access'
     )
  THEN
    GRANT EXECUTE ON FUNCTION public.flow_topic_access(text) TO authenticated;
  END IF;
END
$$;

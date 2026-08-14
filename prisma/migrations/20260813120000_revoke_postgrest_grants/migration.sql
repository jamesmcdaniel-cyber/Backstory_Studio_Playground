-- Close the PostgREST data-API surface on the application schema.
--
-- NEXT_PUBLIC_SUPABASE_ANON_KEY ships in the browser bundle by design, but it is
-- only safe while the `anon` and `authenticated` roles it maps to cannot read
-- application tables. Supabase's project defaults grant table privileges to both
-- roles on objects created in `public`, and Prisma creates every table there.
-- With DATABASE_RLS_ENABLED unset there are no row policies behind those grants,
-- so the published anon key could otherwise read every workspace's rows over
-- https://<project>.supabase.co/rest/v1/<table>.
--
-- Nothing in the product needs those grants: the Supabase JS client is used for
-- Auth and Realtime ONLY — there is no `supabase.from(...)` call anywhere in
-- src/. All data access goes through Prisma.
--
-- Deliberately still working after this migration:
--   * Realtime broadcast/presence (flow jam, run ticks) — rides
--     realtime.messages policies, not public-schema table grants.
--   * public.flow_topic_access(text) — SECURITY DEFINER; its EXECUTE grant to
--     `authenticated` is re-issued below, after the blanket function revoke.
--   * public.handle_new_user() — SECURITY DEFINER trigger on auth.users.
--   * Supabase Storage — separate `storage` schema, service role key.
--
-- ── Privilege model (this is what the first version got wrong) ────────────
-- `ALTER DEFAULT PRIVILEGES FOR ROLE <r>` requires membership in <r>. The first
-- version looped over postgres/supabase_admin/supabase_migration unconditionally
-- and died with "permission denied to change default privileges" on a managed
-- database, which failed the migration and — because Prisma refuses to apply
-- anything after a failed migration — blocked every subsequent deploy.
--
-- So the two halves are treated differently by design:
--
--   REVOKE on existing objects  — the actual fix. Must succeed, and is allowed
--                                 for the object owner, which the migration role
--                                 is for everything Prisma created.
--   ALTER DEFAULT PRIVILEGES    — hardening for FUTURE tables. Best-effort, and
--                                 only for roles this role is a member of.
--                                 A managed platform that forbids it must not
--                                 take production deploys down with it; the
--                                 verification query in
--                                 docs/runbooks/security-controls.md is how you
--                                 confirm the result either way.
--
-- Idempotent, and a no-op on a plain PostgreSQL where anon/authenticated do not
-- exist (CI, local repro).

-- ── 1. Existing objects: the actual revoke, one object at a time. ─────────
--
-- NOT `REVOKE ALL ON ALL TABLES IN SCHEMA public`. That form is all-or-nothing:
-- it raises `permission denied for table X` on the first object the migration
-- role does not own and rolls back the whole statement, so a single foreign
-- object (an extension's table, anything created out-of-band in the Supabase SQL
-- editor by another role) silently leaves EVERY application table still granted.
-- Measured locally: one unowned table in `public` and the revoke touched nothing
-- at all, including the tables the role did own.
--
-- Per-object with a caught exception revokes everything we control and reports
-- the rest by name, which is strictly better than the all-or-nothing form: the
-- application tables are the exposure, and Prisma owns every one of them.
DO $$
DECLARE
  target_role text;
  obj record;
  skipped text[] := '{}';
BEGIN
  FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
      RAISE NOTICE 'role % absent — skipping (expected outside Supabase)', target_role;
      CONTINUE;
    END IF;

    -- Tables, views, materialised views, partitioned and foreign tables.
    FOR obj IN
      SELECT c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
    LOOP
      BEGIN
        EXECUTE format('REVOKE ALL ON public.%I FROM %I', obj.name, target_role);
      EXCEPTION WHEN insufficient_privilege THEN
        skipped := skipped || obj.name;
      END;
    END LOOP;

    FOR obj IN
      SELECT c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'S'
    LOOP
      BEGIN
        EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM %I', obj.name, target_role);
      EXCEPTION WHEN insufficient_privilege THEN
        skipped := skipped || obj.name;
      END;
    END LOOP;

    -- USAGE on the schema stays: without it the SECURITY DEFINER functions are
    -- unreachable by name. USAGE alone confers no data access.
  END LOOP;

  IF array_length(skipped, 1) > 0 THEN
    -- WARNING, not NOTICE: this is visible in the Vercel build log, and each
    -- named object is one this role cannot revoke. Confirm none of them holds
    -- application data with the query in docs/runbooks/security-controls.md.
    RAISE WARNING 'could not revoke on % object(s) (not owned by %): %',
      array_length(skipped, 1), current_user, array_to_string(skipped, ', ');
  END IF;
END
$$;

-- ── 2. Functions: same per-object treatment. Extension-owned functions in
--       `public` are not ours, and one of them must not block the deploy. ────
DO $$
DECLARE
  target_role text;
  fn record;
BEGIN
  FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN CONTINUE; END IF;
    FOR fn IN
      SELECT p.oid::regprocedure AS signature
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
    LOOP
      BEGIN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn.signature, target_role);
      EXCEPTION WHEN insufficient_privilege THEN
        NULL; -- not ours; section 4 re-grants the one function we depend on
      END;
    END LOOP;
  END LOOP;
END
$$;

-- ── 3. Future objects: best-effort, only for roles we belong to. ───────────
DO $$
DECLARE
  target_role text;
  creator_role text;
BEGIN
  FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN CONTINUE; END IF;

    FOR creator_role IN
      SELECT rolname FROM pg_roles
      WHERE rolname IN ('postgres', 'supabase_admin', 'supabase_migration', current_user)
        -- Membership is the precondition for ALTER DEFAULT PRIVILEGES FOR ROLE.
        -- Checking it up front turns the common case from an error into a skip.
        AND pg_has_role(current_user, oid, 'USAGE')
    LOOP
      BEGIN
        EXECUTE format(
          'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM %I',
          creator_role, target_role);
        EXECUTE format(
          'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I',
          creator_role, target_role);
        EXECUTE format(
          'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I',
          creator_role, target_role);
      EXCEPTION WHEN insufficient_privilege THEN
        -- Future tables created BY THAT ROLE may still be granted to the target.
        -- Re-run the revoke in section 1 after any such migration, and confirm
        -- with the verification query in the runbook.
        RAISE NOTICE 'cannot alter default privileges for role % — skipping', creator_role;
      END;
    END LOOP;
  END LOOP;
END
$$;

-- ── 4. Re-issue the one EXECUTE grant the jam channel depends on. The blanket
--       function revoke above is intentionally broad, so this comes after it. ─
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

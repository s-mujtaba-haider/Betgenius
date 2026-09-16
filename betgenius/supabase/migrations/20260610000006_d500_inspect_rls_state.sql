-- D-500 SHIP 1 inspect — read-only check of allowed_emails RLS state.
-- Surfaces: table existence + row count, RLS enabled flag, all existing
-- policies + their definitions, GRANT/REVOKE summary, and column listing.
DO $$
DECLARE r RECORD;
BEGIN
  -- Existence + RLS flag
  FOR r IN
    SELECT relname, relrowsecurity, relforcerowsecurity, reltuples::bigint AS approx_rows
    FROM pg_class
    WHERE oid = 'public.allowed_emails'::regclass
  LOOP
    RAISE NOTICE '[D-500 INSPECT] table=public.% rls_enabled=% rls_forced=% approx_rows=%',
      r.relname, r.relrowsecurity, r.relforcerowsecurity, r.approx_rows;
  END LOOP;

  -- Columns
  RAISE NOTICE '[D-500 INSPECT] --- COLUMNS ---';
  FOR r IN
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='allowed_emails'
    ORDER BY ordinal_position
  LOOP
    RAISE NOTICE 'col % : % nullable=% default=%',
      r.column_name, r.data_type, r.is_nullable, COALESCE(r.column_default, '<none>');
  END LOOP;

  -- All policies (with role + cmd + definition)
  RAISE NOTICE '[D-500 INSPECT] --- POLICIES ---';
  FOR r IN
    SELECT polname, polcmd, polroles::regrole[]::text[] AS roles,
           pg_get_expr(polqual, polrelid) AS using_expr,
           pg_get_expr(polwithcheck, polrelid) AS with_check_expr
    FROM pg_policy
    WHERE polrelid = 'public.allowed_emails'::regclass
  LOOP
    RAISE NOTICE 'policy=% cmd=% roles=% using=% with_check=%',
      r.polname, r.polcmd, array_to_string(r.roles, ','),
      COALESCE(r.using_expr, '<none>'), COALESCE(r.with_check_expr, '<none>');
  END LOOP;

  -- GRANT summary for the role hierarchy
  RAISE NOTICE '[D-500 INSPECT] --- GRANTS ---';
  FOR r IN
    SELECT grantee, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'allowed_emails'
    ORDER BY grantee, privilege_type
  LOOP
    RAISE NOTICE 'grant: % can %', r.grantee, r.privilege_type;
  END LOOP;

  -- Approx row count
  SELECT count(*)::bigint INTO r FROM public.allowed_emails;
  RAISE NOTICE '[D-500 INSPECT] actual row count = %', r;
END $$;

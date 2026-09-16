-- D-503 SHIP 2 — check pick_history RLS state + policies (read-only).
DO $$
DECLARE r RECORD;
BEGIN
  -- RLS flag
  FOR r IN
    SELECT relrowsecurity FROM pg_class WHERE oid = 'public.pick_history'::regclass
  LOOP
    RAISE NOTICE '[D-503 RLS] pick_history rls_enabled=%', r.relrowsecurity;
  END LOOP;

  -- All policies
  RAISE NOTICE '[D-503 RLS] policies on pick_history:';
  FOR r IN
    SELECT polname, polcmd, polroles::regrole[]::text[] AS roles,
           pg_get_expr(polqual, polrelid) AS using_expr,
           pg_get_expr(polwithcheck, polrelid) AS with_check_expr
    FROM pg_policy WHERE polrelid='public.pick_history'::regclass
    ORDER BY polname
  LOOP
    RAISE NOTICE 'policy=% cmd=% roles=% using=% with_check=%',
      r.polname, r.polcmd, array_to_string(r.roles, ','),
      COALESCE(r.using_expr, '<none>'), COALESCE(r.with_check_expr, '<none>');
  END LOOP;

  -- GRANTS
  RAISE NOTICE '[D-503 RLS] grants on pick_history:';
  FOR r IN
    SELECT grantee, privilege_type FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name='pick_history'
    ORDER BY grantee, privilege_type
  LOOP
    RAISE NOTICE 'grant: % can %', r.grantee, r.privilege_type;
  END LOOP;
END $$;

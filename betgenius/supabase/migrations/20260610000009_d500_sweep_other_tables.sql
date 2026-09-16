-- D-500 SHIP 4 sweep — list every public-schema table with its RLS flag
-- AND its policies, so we can spot any OTHER `roles=- using=true`-style
-- wide-open SELECT policy that exposes user data. READ-ONLY (RAISE NOTICE
-- only).
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-500 SWEEP] tables in public schema + RLS state + wide-open SELECT count:';
  FOR r IN
    SELECT
      c.relname AS table_name,
      c.relrowsecurity AS rls_enabled,
      (SELECT count(*) FROM pg_policy p
        WHERE p.polrelid = c.oid AND p.polcmd = 'r') AS select_policy_count,
      -- Count policies that look "wide open": roles unrestricted OR using=true
      (SELECT count(*) FROM pg_policy p
        WHERE p.polrelid = c.oid
          AND p.polcmd = 'r'
          AND (pg_get_expr(p.polqual, p.polrelid) = 'true'
               OR pg_get_expr(p.polqual, p.polrelid) IS NULL)) AS wide_select_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'  -- ordinary tables only (no views, no sequences)
    ORDER BY c.relname
  LOOP
    RAISE NOTICE 'table=% rls=% select_policies=% wide_select_count=%',
      r.table_name, r.rls_enabled, r.select_policy_count, r.wide_select_count;
  END LOOP;

  -- Dump all SELECT policy details for any table that has at least one
  -- wide-open SELECT so we can report precisely which leak.
  RAISE NOTICE '[D-500 SWEEP] all SELECT policies with USING=true or USING=NULL (potentially leaky):';
  FOR r IN
    SELECT
      c.relname AS table_name,
      p.polname AS policy_name,
      p.polroles::regrole[]::text[] AS roles,
      pg_get_expr(p.polqual, p.polrelid) AS using_expr
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND p.polcmd = 'r'
      AND (pg_get_expr(p.polqual, p.polrelid) = 'true'
           OR pg_get_expr(p.polqual, p.polrelid) IS NULL)
    ORDER BY c.relname, p.polname
  LOOP
    RAISE NOTICE 'leak? table=% policy=% roles=% using=%',
      r.table_name, r.policy_name, array_to_string(r.roles, ','),
      COALESCE(r.using_expr, '<none>');
  END LOOP;

  -- Also list any table where rls_enabled = FALSE — those default-allow.
  RAISE NOTICE '[D-500 SWEEP] tables with RLS DISABLED (default-allow on grants):';
  FOR r IN
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity = false
    ORDER BY c.relname
  LOOP
    RAISE NOTICE 'rls_off: table=%', r.table_name;
  END LOOP;
END $$;

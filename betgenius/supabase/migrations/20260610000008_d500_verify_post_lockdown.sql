-- D-500 SHIP 3 verify — confirm policies are in the post-lockdown shape +
-- demonstrate that an admin JWT would clear is_admin() (the gate used by
-- both the now-working pre-existing admin write policies and the new
-- admin SELECT policy).
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-500 VERIFY] policies on public.allowed_emails (must be 4 admin-only — no select_all):';
  FOR r IN
    SELECT polname, polcmd, polroles::regrole[]::text[] AS roles,
           pg_get_expr(polqual, polrelid) AS using_expr,
           pg_get_expr(polwithcheck, polrelid) AS with_check_expr
    FROM pg_policy
    WHERE polrelid = 'public.allowed_emails'::regclass
    ORDER BY polname
  LOOP
    RAISE NOTICE 'policy=% cmd=% roles=% using=% with_check=%',
      r.polname, r.polcmd, array_to_string(r.roles, ','),
      COALESCE(r.using_expr, '<none>'), COALESCE(r.with_check_expr, '<none>');
  END LOOP;

  -- is_admin() definition is unchanged from D-272 / 20260429000003;
  -- it returns auth.jwt()->>'email' = 'admin@example.com'. The Admin
  -- page's Authorization header (session.access_token) carries that JWT
  -- when the admin is signed in. So:
  --   - admin signed-in: is_admin() = TRUE → SELECT/INSERT/UPDATE/DELETE all admit
  --   - anon-key: auth.jwt() returns no email → is_admin() = FALSE → all 4 deny
  --   - authenticated non-admin: is_admin() = FALSE → all 4 deny
  RAISE NOTICE '[D-500 VERIFY] is_admin() definition (unchanged from D-272 RLS setup):';
  FOR r IN
    SELECT pg_get_functiondef('public.is_admin'::regproc) AS def
  LOOP
    RAISE NOTICE '%', r.def;
  END LOOP;

  -- Row count — confirms the table itself still has the original data
  -- (no data was touched; only the SELECT policy was swapped).
  SELECT count(*)::text INTO r FROM public.allowed_emails;
  RAISE NOTICE '[D-500 VERIFY] allowed_emails row count = % (unchanged)', r;
END $$;

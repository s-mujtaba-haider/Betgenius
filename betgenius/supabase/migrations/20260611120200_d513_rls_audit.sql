DO $$
DECLARE r RECORD; v_n INT;
BEGIN
  -- §a Tables with RLS DISABLED
  RAISE NOTICE '[D-513 §5a] tables in public with RLS DISABLED:';
  FOR r IN
    SELECT relname FROM pg_class
    WHERE relnamespace = (SELECT oid FROM pg_namespace WHERE nspname='public')
      AND relkind='r' AND relrowsecurity = false
    ORDER BY relname
  LOOP RAISE NOTICE '  rls_off=%', r.relname; END LOOP;

  -- §b Tables with RLS enabled + authenticated SELECT policy (anyone with JWT can read)
  RAISE NOTICE '[D-513 §5b] tables with authenticated-SELECT policy (count):';
  SELECT count(DISTINCT tablename) INTO v_n
    FROM pg_policies
    WHERE schemaname='public' AND cmd='SELECT'
      AND ('authenticated' = ANY(roles) OR 'public' = ANY(roles));
  RAISE NOTICE '  count_authenticated_select_tables=%', v_n;

  -- Show list with their policies
  RAISE NOTICE '[D-513 §5c] authenticated-read tables (first 25):';
  FOR r IN
    SELECT DISTINCT tablename FROM pg_policies
    WHERE schemaname='public' AND cmd='SELECT'
      AND ('authenticated' = ANY(roles) OR 'public' = ANY(roles))
    ORDER BY tablename LIMIT 25
  LOOP RAISE NOTICE '  %', r.tablename; END LOOP;

  -- §d Sensitive tables: bets, profiles, allowed_emails — what are THEIR policies?
  RAISE NOTICE '[D-513 §5d] sensitive table policies:';
  FOR r IN
    SELECT tablename, policyname, cmd, roles, qual FROM pg_policies
    WHERE schemaname='public' AND tablename IN
      ('bets','profiles','allowed_emails','user_preferences','user_settings')
    ORDER BY tablename, policyname
  LOOP RAISE NOTICE '  table=% policy=% cmd=% roles=% qual=%',
    r.tablename, r.policyname, r.cmd, r.roles, COALESCE(left(r.qual::text,80),'<null>'); END LOOP;
END $$;

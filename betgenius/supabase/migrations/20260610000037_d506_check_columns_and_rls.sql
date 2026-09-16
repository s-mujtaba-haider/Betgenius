DO $$
DECLARE r RECORD; v_col_count INT;
BEGIN
  -- Verify all 13 columns the function selects still exist
  RAISE NOTICE '[D-506] pick_history columns the resolve-picks SELECT requires:';
  FOR r IN
    SELECT col, EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='pick_history' AND column_name=col
    ) AS present
    FROM unnest(ARRAY['id','player_name','team','prop_type','line','pick_side',
                       'game_time','created_at','sport','opponent','mlb_market_type',
                       'game_date','is_home']) AS col
  LOOP
    RAISE NOTICE '  % present=%', r.col, r.present;
  END LOOP;

  -- Check RLS policies on pick_history (service role bypasses, but anon doesn't)
  RAISE NOTICE '[D-506] pick_history RLS status:';
  SELECT relrowsecurity, relforcerowsecurity
    INTO r
    FROM pg_class
   WHERE relname='pick_history' AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname='public');
  RAISE NOTICE '  rls_enabled=% rls_forced=%', r.relrowsecurity, r.relforcerowsecurity;

  RAISE NOTICE '[D-506] pick_history grants for anon + service_role + authenticated:';
  FOR r IN
    SELECT grantee, privilege_type
      FROM information_schema.role_table_grants
     WHERE table_schema='public' AND table_name='pick_history'
       AND grantee IN ('anon', 'authenticated', 'service_role', 'PUBLIC', 'postgres')
       AND privilege_type IN ('SELECT', 'UPDATE')
     ORDER BY grantee, privilege_type
  LOOP
    RAISE NOTICE '  grant grantee=% priv=%', r.grantee, r.privilege_type;
  END LOOP;

  -- Final check: total row count in pick_history (sanity)
  DECLARE v_total BIGINT;
  BEGIN
    SELECT count(*) INTO v_total FROM public.pick_history;
    RAISE NOTICE '[D-506] pick_history total rows: %', v_total;
  END;
END $$;

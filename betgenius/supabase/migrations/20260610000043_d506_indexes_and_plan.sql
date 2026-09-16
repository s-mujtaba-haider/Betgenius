DO $$
DECLARE r RECORD; v_start_ts TIMESTAMPTZ; v_end_ts TIMESTAMPTZ;
BEGIN
  -- All indexes on pick_history
  RAISE NOTICE '[D-506] pick_history indexes:';
  FOR r IN
    SELECT indexname, indexdef FROM pg_indexes
     WHERE schemaname='public' AND tablename='pick_history'
     ORDER BY indexname
  LOOP
    RAISE NOTICE '  % | %', r.indexname, r.indexdef;
  END LOOP;

  -- Time the equivalent SQL query (we already confirmed SQL works, but is it FAST?)
  SET LOCAL statement_timeout TO '60s';
  v_start_ts := clock_timestamp();
  PERFORM id FROM public.pick_history
   WHERE hit IS NULL AND resolved_at IS NULL AND voided <> true
     AND game_date >= DATE '2026-05-28'
   ORDER BY created_at ASC LIMIT 200;
  v_end_ts := clock_timestamp();
  RAISE NOTICE '[D-506] SQL query duration: % ms', extract(milliseconds from (v_end_ts - v_start_ts));

  -- Get the EXPLAIN plan
  RAISE NOTICE '[D-506] EXPLAIN ANALYZE picks query:';
  FOR r IN
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT id, player_name, team, prop_type, line, pick_side, game_time, created_at,
           sport, opponent, mlb_market_type, game_date, is_home
    FROM public.pick_history
    WHERE hit IS NULL AND resolved_at IS NULL AND voided <> true
      AND game_date >= DATE '2026-05-28'
    ORDER BY created_at ASC LIMIT 200
  LOOP
    RAISE NOTICE '  %', r."QUERY PLAN";
  END LOOP;

  -- PostgREST role statement_timeout
  RAISE NOTICE '[D-506] PostgREST role statement_timeouts:';
  FOR r IN
    SELECT rolname, rolconfig FROM pg_roles
    WHERE rolname IN ('anon','authenticated','service_role','authenticator')
  LOOP
    RAISE NOTICE '  rolname=% rolconfig=%', r.rolname, r.rolconfig;
  END LOOP;
END $$;

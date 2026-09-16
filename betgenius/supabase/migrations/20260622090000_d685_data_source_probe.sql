-- D-685 SHIP 2 — probe cache table population for the data sources backing
-- removed factors. NOTICE-only; no writes.
DO $$
DECLARE r RECORD; v_n INT; BEGIN
  RAISE NOTICE '──── D-685 cache table population probe ────';
  FOR r IN
    SELECT relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND (relname LIKE 'cache_mlb_%' OR relname LIKE 'cache_ballpark%')
    ORDER BY relname
  LOOP
    EXECUTE format('SELECT COUNT(*) FROM public.%I', r.relname) INTO v_n;
    RAISE NOTICE 'cache: % rows=%', r.relname, v_n;
  END LOOP;

  -- explicit check for the smaller targeted set
  RAISE NOTICE '──── targeted (per-factor data source) ────';
  BEGIN
    SELECT COUNT(*) INTO v_n FROM public.cache_mlb_batter_vs_pitcher_hand_splits;
    RAISE NOTICE 'handedness split data: % rows', v_n;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'cache_mlb_batter_vs_pitcher_hand_splits: NOT PRESENT'; END;
  BEGIN
    SELECT COUNT(*) INTO v_n FROM public.cache_mlb_lineups WHERE confirmed_at >= NOW() - INTERVAL '12 hours';
    RAISE NOTICE 'lineups confirmed last 12h: % rows', v_n;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'cache_mlb_lineups: NOT PRESENT or no confirmed_at col'; END;
  BEGIN
    SELECT COUNT(*) INTO v_n FROM public.cache_mlb_h2h_history;
    RAISE NOTICE 'h2h history: % rows', v_n;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'cache_mlb_h2h_history: NOT PRESENT'; END;
  BEGIN
    SELECT COUNT(*) INTO v_n FROM public.cache_mlb_pen_rest WHERE updated_at >= NOW() - INTERVAL '24 hours';
    RAISE NOTICE 'pen_rest fresh last 24h: % rows', v_n;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'cache_mlb_pen_rest: NOT PRESENT or no updated_at'; END;
END $$;

DO $$
DECLARE r RECORD; v_n INT; BEGIN
  -- pen_rest schema check
  RAISE NOTICE 'cache_mlb_pen_rest column list:';
  FOR r IN
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cache_mlb_pen_rest'
    ORDER BY ordinal_position
  LOOP
    RAISE NOTICE '  pen_rest col: % (%)', r.column_name, r.data_type;
  END LOOP;

  -- pen_rest fresh rows
  BEGIN
    SELECT COUNT(*) INTO v_n FROM public.cache_mlb_pen_rest WHERE refreshed_at >= NOW() - INTERVAL '7 days';
    RAISE NOTICE 'cache_mlb_pen_rest fresh last 7d: %', v_n;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      SELECT COUNT(*) INTO v_n FROM public.cache_mlb_pen_rest;
      RAISE NOTICE 'cache_mlb_pen_rest total (no fresh-col): %', v_n;
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pen_rest probe failed'; END;
  END;

  -- batter_splits = vs LHP/RHP data?
  RAISE NOTICE 'cache_mlb_batter_splits column list:';
  FOR r IN
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cache_mlb_batter_splits'
    ORDER BY ordinal_position LIMIT 15
  LOOP
    RAISE NOTICE '  batter_splits col: % (%)', r.column_name, r.data_type;
  END LOOP;

  -- lineup confirmation watcher state — look for tables with "lineup" in name
  RAISE NOTICE 'tables with lineup in name:';
  FOR r IN
    SELECT relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND relname LIKE '%lineup%'
    ORDER BY relname
  LOOP
    EXECUTE format('SELECT COUNT(*) FROM public.%I', r.relname) INTO v_n;
    RAISE NOTICE '  % rows=%', r.relname, v_n;
  END LOOP;

  -- h2h
  RAISE NOTICE 'tables with h2h or head_to_head:';
  FOR r IN
    SELECT relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND (relname LIKE '%h2h%' OR relname LIKE '%head_to%')
    ORDER BY relname
  LOOP
    EXECUTE format('SELECT COUNT(*) FROM public.%I', r.relname) INTO v_n;
    RAISE NOTICE '  % rows=%', r.relname, v_n;
  END LOOP;

  -- team season / batter season
  RAISE NOTICE 'tables with batter_season or team_season:';
  FOR r IN
    SELECT relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r'
      AND (relname LIKE '%batter_season%' OR relname LIKE '%team_season%' OR relname LIKE '%team_recent%')
    ORDER BY relname
  LOOP
    EXECUTE format('SELECT COUNT(*) FROM public.%I', r.relname) INTO v_n;
    RAISE NOTICE '  % rows=%', r.relname, v_n;
  END LOOP;
END $$;

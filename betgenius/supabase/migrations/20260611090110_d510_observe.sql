DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '180s';
  PERFORM pg_sleep(100);

  RAISE NOTICE '[D-510 observe] mlb_scoring_progress today after run:';
  FOR r IN SELECT count(*) AS n FROM public.mlb_scoring_progress WHERE game_date='20260611'
  LOOP RAISE NOTICE '  scored_count=%', r.n; END LOOP;

  -- §a rbi cluster: must now be CAPPED (0 picks at conf>=80 OVER +150+)
  RAISE NOTICE '[D-510 observe] §a batter_rbis conf>=80 OVER odds>=150 today (should be 0):';
  FOR r IN
    SELECT count(*) AS n, min(confidence) AS min_c, max(confidence) AS max_c,
           array_agg(player_name) AS sample
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date=(NOW() AT TIME ZONE 'America/New_York')::DATE
      AND mlb_market_type='batter_rbis'
      AND pick_side='over' AND odds >= 150
      AND confidence >= 80
  LOOP RAISE NOTICE '  n=% min_c=% max_c=% samples=%', r.n, r.min_c, r.max_c, r.sample; END LOOP;

  -- §b rbi +100..149 band: untouched (still produces conf>=80 if applicable)
  RAISE NOTICE '[D-510 observe] §b batter_rbis conf>=80 OVER odds 100..149 today (NOT capped):';
  FOR r IN
    SELECT count(*) AS n, min(confidence) AS min_c, max(confidence) AS max_c,
           array_agg(player_name) AS sample
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date=(NOW() AT TIME ZONE 'America/New_York')::DATE
      AND mlb_market_type='batter_rbis'
      AND pick_side='over' AND odds BETWEEN 100 AND 149
      AND confidence >= 80
  LOOP RAISE NOTICE '  n=% min_c=% max_c=% samples=%', r.n, r.min_c, r.max_c, r.sample; END LOOP;

  -- §c HR carve-out STILL preserved (must still produce conf>=80 OVER +150+ samples)
  RAISE NOTICE '[D-510 observe] §c batter_hr conf>=80 OVER odds>=150 today (D-456 carve-out — should still be UNCAPPED):';
  FOR r IN
    SELECT count(*) AS n, min(confidence) AS min_c, max(confidence) AS max_c,
           array_agg(player_name) AS sample
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date=(NOW() AT TIME ZONE 'America/New_York')::DATE
      AND mlb_market_type='batter_hr'
      AND pick_side='over' AND odds >= 150
      AND confidence >= 80
  LOOP RAISE NOTICE '  n=% min_c=% max_c=% samples=%', r.n, r.min_c, r.max_c, r.sample; END LOOP;

  -- §d rbi UNDER (any odds, conf>=80) — D-510 must NOT touch unders
  RAISE NOTICE '[D-510 observe] §d batter_rbis UNDER conf>=80 today (D-510 NO effect on UNDER):';
  FOR r IN
    SELECT count(*) AS n, min(confidence) AS min_c, max(confidence) AS max_c
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date=(NOW() AT TIME ZONE 'America/New_York')::DATE
      AND mlb_market_type='batter_rbis'
      AND pick_side='under' AND confidence >= 80
  LOOP RAISE NOTICE '  n=% min_c=% max_c=%', r.n, r.min_c, r.max_c; END LOOP;

  -- §e Non-cluster ELITE/STRONG samples (must be untouched, exactly like D-509 verify)
  RAISE NOTICE '[D-510 observe] §e non-cluster ELITE/STRONG sanity (untouched):';
  FOR r IN
    SELECT mlb_market_type, pick_side,
           CASE WHEN odds < 0 THEN 'fav' WHEN odds < 150 THEN '+100..149' ELSE '+150+' END AS band,
           count(*) AS n, min(confidence) AS min_c, max(confidence) AS max_c
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date=(NOW() AT TIME ZONE 'America/New_York')::DATE
      AND confidence >= 80
      AND NOT (
        pick_side='over' AND (
          (odds >= 150 AND mlb_market_type NOT IN ('batter_hr'))
          OR mlb_market_type='game_total'
        )
      )
    GROUP BY mlb_market_type, pick_side, band
    ORDER BY n DESC LIMIT 20
  LOOP RAISE NOTICE '  market=% side=% band=% n=% min_c=% max_c=%',
    r.mlb_market_type, r.pick_side, r.band, r.n, r.min_c, r.max_c; END LOOP;

  -- §f Error log clean
  RAISE NOTICE '[D-510 observe] §f error_log last 5 min (process-games-mlb, non-routine):';
  FOR r IN
    SELECT created_at, error_type, left(error_message, 200) AS msg
    FROM public.error_log
    WHERE created_at > NOW() - INTERVAL '5 minutes'
      AND function_name='process-games-mlb'
      AND error_type NOT IN ('checkpoint','splits_cache_miss')
    ORDER BY created_at DESC LIMIT 10
  LOOP RAISE NOTICE '  at=% type=% msg=%', r.created_at, r.error_type, r.msg; END LOOP;
END $$;

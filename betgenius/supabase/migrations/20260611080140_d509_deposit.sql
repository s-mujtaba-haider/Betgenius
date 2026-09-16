DO $$
DECLARE r RECORD;
BEGIN
  -- Picks at exactly conf=75 today (D-509 cap-deposit value)
  RAISE NOTICE '[D-509 §f] today picks at exactly conf=75:';
  FOR r IN
    SELECT mlb_market_type, pick_side,
           CASE WHEN odds < 0 THEN 'fav' WHEN odds < 150 THEN '+100..149' ELSE '+150+' END AS band,
           count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date=(NOW() AT TIME ZONE 'America/New_York')::DATE
      AND confidence = 75
    GROUP BY mlb_market_type, pick_side, band
    ORDER BY n DESC
  LOOP RAISE NOTICE '  market=% side=% band=% n=%', r.mlb_market_type, r.pick_side, r.band, r.n; END LOOP;

  -- Yesterday for context (no D-509 was active then)
  RAISE NOTICE '[D-509 §g] yesterday cluster picks (pre-D-509 control):';
  FOR r IN
    SELECT mlb_market_type, count(*) AS n,
           min(confidence) AS min_c, max(confidence) AS max_c
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date=(NOW() AT TIME ZONE 'America/New_York')::DATE - 1
      AND pick_side='over' AND confidence >= 80 AND odds >= 150
      AND mlb_market_type NOT IN ('batter_rbis','batter_hr')
    GROUP BY mlb_market_type ORDER BY n DESC LIMIT 10
  LOOP RAISE NOTICE '  market=% n=% min_c=% max_c=%',
    r.mlb_market_type, r.n, r.min_c, r.max_c; END LOOP;

  -- And yesterday's game_total OVER conf>=80
  RAISE NOTICE '[D-509 §h] yesterday game_total OVER conf>=80 (pre-D-509 control):';
  FOR r IN
    SELECT count(*) AS n, min(confidence) AS min_c, max(confidence) AS max_c
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date=(NOW() AT TIME ZONE 'America/New_York')::DATE - 1
      AND pick_side='over' AND confidence >= 80
      AND mlb_market_type='game_total'
  LOOP RAISE NOTICE '  n=% min_c=% max_c=%', r.n, r.min_c, r.max_c; END LOOP;
END $$;

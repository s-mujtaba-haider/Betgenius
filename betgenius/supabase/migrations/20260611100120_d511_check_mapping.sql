DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-511 mapping] mlb_market_type ↔ prop_type cross-reference (today):';
  FOR r IN
    SELECT mlb_market_type, prop_type, count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date=(NOW() AT TIME ZONE 'America/New_York')::DATE
    GROUP BY mlb_market_type, prop_type ORDER BY mlb_market_type
  LOOP RAISE NOTICE '  mlb_market_type=% prop_type=% n=%', r.mlb_market_type, r.prop_type, r.n; END LOOP;

  RAISE NOTICE '[D-511 mapping] props_cache prop_type distinct values (today):';
  FOR r IN
    SELECT prop_type, count(*) AS n
    FROM public.props_cache
    WHERE sport='mlb' AND game_date='20260611'
    GROUP BY prop_type ORDER BY n DESC
  LOOP RAISE NOTICE '  prop_type=% n=%', r.prop_type, r.n; END LOOP;
END $$;

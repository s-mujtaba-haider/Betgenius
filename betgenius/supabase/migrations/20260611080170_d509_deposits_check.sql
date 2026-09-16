DO $$
DECLARE r RECORD;
BEGIN
  -- D-509 deposit zone: picks AT EXACTLY conf=75 OVER (odds>=150 OR game_total),
  -- excluding rbi/HR. These are picks the D-509 cap brought DOWN to 75.
  RAISE NOTICE '[D-509 deposit] picks at conf=75 in D-509 deposit zone (today):';
  FOR r IN
    SELECT mlb_market_type, pick_side, count(*) AS n,
           array_agg(player_name) FILTER (WHERE confidence=75) AS samples
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date=(NOW() AT TIME ZONE 'America/New_York')::DATE
      AND confidence = 75
      AND pick_side='over'
      AND ((odds >= 150 AND mlb_market_type NOT IN ('batter_rbis','batter_hr'))
           OR mlb_market_type='game_total')
    GROUP BY mlb_market_type, pick_side
  LOOP RAISE NOTICE '  market=% side=% n=% samples=%',
    r.mlb_market_type, r.pick_side, r.n, r.samples; END LOOP;

  -- Compare to YESTERDAY at conf=80+ in same zone (pre-D-509)
  RAISE NOTICE '[D-509 deposit] yesterday conf>=80 OVER in same zone (pre-D-509 control):';
  FOR r IN
    SELECT mlb_market_type, pick_side, count(*) AS n,
           min(confidence) AS min_c, max(confidence) AS max_c
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date=(NOW() AT TIME ZONE 'America/New_York')::DATE - 1
      AND confidence >= 80 AND pick_side='over'
      AND ((odds >= 150 AND mlb_market_type NOT IN ('batter_rbis','batter_hr'))
           OR mlb_market_type='game_total')
    GROUP BY mlb_market_type, pick_side ORDER BY n DESC
  LOOP RAISE NOTICE '  market=% side=% n=% min_c=% max_c=%',
    r.mlb_market_type, r.pick_side, r.n, r.min_c, r.max_c; END LOOP;
END $$;

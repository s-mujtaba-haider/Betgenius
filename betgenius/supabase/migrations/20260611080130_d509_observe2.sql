-- D-509 — re-check using game_date today (not created_at).
-- UPSERTs preserve original created_at but update confidence.
DO $$
DECLARE r RECORD;
BEGIN
  -- §a Cluster: conf>=80 OVER picks for today
  RAISE NOTICE '[D-509 step3b] §a1 today conf>=80 OVER odds>=150 picks (cluster, excl rbi/HR):';
  FOR r IN
    SELECT mlb_market_type, count(*) AS n,
           min(confidence) AS min_c, max(confidence) AS max_c
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date=(NOW() AT TIME ZONE 'America/New_York')::DATE
      AND pick_side='over' AND confidence >= 80 AND odds >= 150
      AND mlb_market_type NOT IN ('batter_rbis','batter_hr')
    GROUP BY mlb_market_type ORDER BY n DESC
  LOOP RAISE NOTICE '  market=% n=% min_c=% max_c=% (D-509 should drive these to 0 / max_c<=75)',
    r.mlb_market_type, r.n, r.min_c, r.max_c; END LOOP;

  RAISE NOTICE '[D-509 step3b] §a2 today game_total OVER conf>=80:';
  FOR r IN
    SELECT count(*) AS n, min(confidence) AS min_c, max(confidence) AS max_c
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date=(NOW() AT TIME ZONE 'America/New_York')::DATE
      AND pick_side='over' AND confidence >= 80
      AND mlb_market_type='game_total'
  LOOP RAISE NOTICE '  n=% min_c=% max_c=% (should be 0; cluster bleed)',
    r.n, r.min_c, r.max_c; END LOOP;

  -- §b Carve-outs preserved
  RAISE NOTICE '[D-509 step3b] §b today CARVE-OUTS (rbis + hr) conf>=80 OVER odds>=150:';
  FOR r IN
    SELECT mlb_market_type, count(*) AS n,
           min(confidence) AS min_c, max(confidence) AS max_c
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date=(NOW() AT TIME ZONE 'America/New_York')::DATE
      AND pick_side='over' AND confidence >= 80 AND odds >= 150
      AND mlb_market_type IN ('batter_rbis','batter_hr')
    GROUP BY mlb_market_type
  LOOP RAISE NOTICE '  market=% n=% min_c=% max_c=% (carve-out: should preserve)',
    r.mlb_market_type, r.n, r.min_c, r.max_c; END LOOP;

  -- §c Cluster band at 71-75 (D-509 should DROP capped picks here from 80+)
  RAISE NOTICE '[D-509 step3b] §c today conf=71-75 OVER odds>=150 (D-509 deposit zone, excl rbi/HR):';
  FOR r IN
    SELECT mlb_market_type, count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date=(NOW() AT TIME ZONE 'America/New_York')::DATE
      AND pick_side='over' AND confidence BETWEEN 71 AND 75 AND odds >= 150
      AND mlb_market_type NOT IN ('batter_rbis','batter_hr')
    GROUP BY mlb_market_type ORDER BY n DESC
  LOOP RAISE NOTICE '  market=% n=%', r.mlb_market_type, r.n; END LOOP;

  -- §d Non-cluster ELITE/STRONG samples (favorites/unders/rbis/HR — should still be 80+)
  RAISE NOTICE '[D-509 step3b] §d today NON-CLUSTER ELITE/STRONG (untouched):';
  FOR r IN
    SELECT mlb_market_type, pick_side,
           CASE WHEN odds < 0 THEN 'favorite' WHEN odds < 150 THEN '+100..149' ELSE '+150+' END AS odds_band,
           count(*) AS n, min(confidence) AS min_c, max(confidence) AS max_c
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date=(NOW() AT TIME ZONE 'America/New_York')::DATE
      AND confidence >= 80
      AND NOT (
        pick_side='over' AND (
          (odds >= 150 AND mlb_market_type NOT IN ('batter_rbis','batter_hr'))
          OR mlb_market_type='game_total'
        )
      )
    GROUP BY mlb_market_type, pick_side, odds_band
    ORDER BY n DESC LIMIT 20
  LOOP RAISE NOTICE '  market=% side=% band=% n=% min_c=% max_c=%',
    r.mlb_market_type, r.pick_side, r.odds_band, r.n, r.min_c, r.max_c; END LOOP;

  -- §e Total today's ELITE/STRONG count (sanity vs yesterday)
  RAISE NOTICE '[D-509 step3b] §e today vs yesterday ELITE/STRONG total counts:';
  FOR r IN
    SELECT game_date, count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND confidence >= 80
      AND game_date IN (
        (NOW() AT TIME ZONE 'America/New_York')::DATE,
        (NOW() AT TIME ZONE 'America/New_York')::DATE - 1
      )
    GROUP BY game_date ORDER BY game_date DESC
  LOOP RAISE NOTICE '  gd=% n=%', r.game_date, r.n; END LOOP;
END $$;

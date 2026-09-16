DO $$
DECLARE r RECORD;
BEGIN
  -- D-509 — split the n=100 cluster by sport
  RAISE NOTICE '[D-509 §a] ELITE/STRONG longshot-OVER cluster split by sport:';
  FOR r IN
    SELECT sport,
           count(*) AS n,
           count(*) FILTER (WHERE hit) AS wins,
           ROUND(100.0*count(*) FILTER (WHERE hit)/NULLIF(count(*),0), 2) AS wr,
           ROUND(SUM(CASE WHEN hit THEN (odds*1.0/100.0)
                          WHEN hit IS FALSE THEN -1.0 ELSE 0 END)::NUMERIC, 2) AS units
    FROM public.pick_history_real
    WHERE pick_side='over' AND odds >= 100 AND confidence >= 80 AND is_synthetic = false
    GROUP BY sport ORDER BY n DESC
  LOOP RAISE NOTICE '  sport=% n=% wins=% wr=% units=%',
    r.sport, r.n, r.wins, r.wr, r.units; END LOOP;

  -- Concentration: +150-+199 cluster
  RAISE NOTICE '[D-509 §b] +150+ band within conf>=80 OVER (by sport):';
  FOR r IN
    SELECT sport,
           count(*) AS n,
           count(*) FILTER (WHERE hit) AS wins,
           ROUND(100.0*count(*) FILTER (WHERE hit)/NULLIF(count(*),0), 2) AS wr,
           ROUND(SUM(CASE WHEN hit THEN (odds*1.0/100.0)
                          WHEN hit IS FALSE THEN -1.0 ELSE 0 END)::NUMERIC, 2) AS units
    FROM public.pick_history_real
    WHERE pick_side='over' AND odds >= 150 AND confidence >= 80 AND is_synthetic = false
    GROUP BY sport ORDER BY n DESC
  LOOP RAISE NOTICE '  sport=% n=% wins=% wr=% units=%',
    r.sport, r.n, r.wins, r.wr, r.units; END LOOP;

  -- Game_total OVER conf>=80 (any odds)
  RAISE NOTICE '[D-509 §c] game_total OVER conf>=80 by sport:';
  FOR r IN
    SELECT sport, prop_type, mlb_market_type,
           count(*) AS n,
           count(*) FILTER (WHERE hit) AS wins,
           ROUND(100.0*count(*) FILTER (WHERE hit)/NULLIF(count(*),0), 2) AS wr,
           ROUND(SUM(CASE WHEN hit THEN (odds*1.0/100.0)
                          WHEN hit IS FALSE THEN -1.0 ELSE 0 END)::NUMERIC, 2) AS units
    FROM public.pick_history_real
    WHERE pick_side='over' AND confidence >= 80 AND is_synthetic = false
      AND (prop_type='totals' OR mlb_market_type='game_total')
    GROUP BY sport, prop_type, mlb_market_type ORDER BY n DESC
  LOOP RAISE NOTICE '  sport=% prop=% mkt=% n=% wins=% wr=% units=%',
    r.sport, r.prop_type, r.mlb_market_type, r.n, r.wins, r.wr, r.units; END LOOP;

  -- Carve-outs: batter_rbis + HR conf>=80 OVER >=+100 (these MUST NOT be capped)
  RAISE NOTICE '[D-509 §d] CARVE-OUT cohorts (must NOT be capped):';
  FOR r IN
    SELECT mlb_market_type,
           count(*) AS n,
           count(*) FILTER (WHERE hit) AS wins,
           ROUND(100.0*count(*) FILTER (WHERE hit)/NULLIF(count(*),0), 2) AS wr,
           ROUND(SUM(CASE WHEN hit THEN (odds*1.0/100.0)
                          WHEN hit IS FALSE THEN -1.0 ELSE 0 END)::NUMERIC, 2) AS units
    FROM public.pick_history_real
    WHERE sport='mlb' AND pick_side='over' AND odds >= 100 AND confidence >= 80
      AND is_synthetic = false
      AND mlb_market_type IN ('batter_rbis','batter_hr')
    GROUP BY mlb_market_type
  LOOP RAISE NOTICE '  market=% n=% wins=% wr=% units=%',
    r.mlb_market_type, r.n, r.wins, r.wr, r.units; END LOOP;
END $$;

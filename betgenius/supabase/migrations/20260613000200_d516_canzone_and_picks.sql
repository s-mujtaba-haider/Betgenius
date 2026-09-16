DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '90s';

  -- Canzone (today)
  RAISE NOTICE '[D-516 §2a] Canzone today (any conf):';
  FOR r IN
    SELECT id, player_name, line, pick_side, odds, confidence, mlb_market_type,
           breakdown
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date = (NOW() AT TIME ZONE 'America/New_York')::DATE
      AND player_name ILIKE '%Canzone%'
    LIMIT 5
  LOOP
    RAISE NOTICE 'pid=% player=% market=% line=% side=% odds=% conf=%',
      r.id, r.player_name, r.mlb_market_type, r.line, r.pick_side, r.odds, r.confidence;
    RAISE NOTICE 'breakdown=%', r.breakdown::text;
  END LOOP;

  -- 10 high-conf batter picks last 14 days with breakdown
  RAISE NOTICE '[D-516 §2b] 10 high-conf (>=95) batter picks last 14 days with breakdown:';
  FOR r IN
    SELECT id, player_name, mlb_market_type, line, pick_side, odds, confidence,
           breakdown
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 14
      AND confidence >= 95
      AND mlb_market_type IN ('batter_total_bases','batter_rbis','batter_hits',
                              'batter_runs_scored','batter_strikeouts')
      AND breakdown IS NOT NULL
    ORDER BY confidence DESC, created_at DESC LIMIT 10
  LOOP
    RAISE NOTICE '----- pid=% player=% market=% line=% side=% odds=% conf=%',
      r.id, r.player_name, r.mlb_market_type, r.line, r.pick_side, r.odds, r.confidence;
    RAISE NOTICE '  breakdown=%', LEFT(r.breakdown::text, 1500);
  END LOOP;

  -- Also a few high-conf with breakdown=null (do they exist?)
  RAISE NOTICE '[D-516 §2c] high-conf batter picks WITH NULL breakdown (last 14d):';
  FOR r IN
    SELECT count(*) AS n FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 14
      AND confidence >= 95
      AND mlb_market_type IN ('batter_total_bases','batter_rbis','batter_hits',
                              'batter_runs_scored','batter_strikeouts')
      AND breakdown IS NULL
  LOOP RAISE NOTICE '  null_breakdown=%', r.n; END LOOP;

END $$;

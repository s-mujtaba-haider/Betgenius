DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  -- §0 — what columns does pick_history have for factor scores?
  RAISE NOTICE '[D-516 §2.0] pick_history columns containing "score" / "rate" / "hit":';
  FOR r IN
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name='pick_history'
      AND (column_name ILIKE '%score%'
        OR column_name ILIKE '%hit_rate%'
        OR column_name ILIKE '%hitRate%'
        OR column_name ILIKE '%breakdown%'
        OR column_name ILIKE '%factor%'
        OR column_name ILIKE '%confidence%'
        OR column_name ILIKE '%season%'
        OR column_name ILIKE '%l5%' OR column_name ILIKE '%l10%')
    ORDER BY column_name
  LOOP RAISE NOTICE '  % %', r.column_name, r.data_type; END LOOP;

  -- §a — find the Canzone pick (today, conf=95+, total_bases)
  RAISE NOTICE '[D-516 §2a] Canzone pick lookup today:';
  FOR r IN
    SELECT id, player_name, line, pick_side, odds, confidence,
           mlb_market_type, created_at
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date = (NOW() AT TIME ZONE 'America/New_York')::DATE
      AND player_name ILIKE '%Canzone%'
    LIMIT 5
  LOOP RAISE NOTICE '  pid=% player=% line=% side=% odds=% conf=% market=% at=%',
    r.id, r.player_name, r.line, r.pick_side, r.odds, r.confidence, r.mlb_market_type, r.created_at; END LOOP;

  -- §b — Dump full breakdown for 10 picks at conf>=95 (real, recent) batter markets
  RAISE NOTICE '[D-516 §2b] 10 high-conf (95+) batter picks last 7 days — full breakdown:';
  FOR r IN
    SELECT id, player_name, mlb_market_type, line, pick_side, odds, confidence,
           breakdown
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 7
      AND confidence >= 95
      AND mlb_market_type IN ('batter_total_bases','batter_rbis','batter_hits',
                              'batter_runs_scored','batter_hr','batter_strikeouts')
      AND breakdown IS NOT NULL
    ORDER BY confidence DESC, created_at DESC
    LIMIT 10
  LOOP
    RAISE NOTICE '----- pid=% player=% market=% line=% side=% odds=% conf=%',
      r.id, r.player_name, r.mlb_market_type, r.line, r.pick_side, r.odds, r.confidence;
    RAISE NOTICE '  breakdown=%', r.breakdown::text;
  END LOOP;
END $$;

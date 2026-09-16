-- D-509 final verify after multi-trigger
DO $$
DECLARE r RECORD; v_scored BIGINT;
BEGIN
  SELECT count(*) INTO v_scored FROM public.mlb_scoring_progress WHERE game_date='20260611';
  RAISE NOTICE '[D-509 final] today scored = % games', v_scored;

  -- §a Cluster picks (should be 0 outside carve-outs)
  RAISE NOTICE '[D-509 final] §a CLUSTER conf>=80 OVER odds>=150 (excl rbi/HR):';
  FOR r IN
    SELECT mlb_market_type, count(*) AS n, max(confidence) AS max_c
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date=(NOW() AT TIME ZONE 'America/New_York')::DATE
      AND pick_side='over' AND confidence >= 80 AND odds >= 150
      AND mlb_market_type NOT IN ('batter_rbis','batter_hr')
    GROUP BY mlb_market_type ORDER BY n DESC
  LOOP RAISE NOTICE '  market=% n=% max_c=%', r.mlb_market_type, r.n, r.max_c; END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM public.pick_history WHERE sport='mlb' AND is_synthetic=false
      AND game_date=(NOW() AT TIME ZONE 'America/New_York')::DATE
      AND pick_side='over' AND confidence >= 80 AND odds >= 150
      AND mlb_market_type NOT IN ('batter_rbis','batter_hr')
  ) THEN RAISE NOTICE '  → ZERO rows ✓ cluster (excl carve-outs) CAPPED'; END IF;

  -- §b game_total OVER conf>=80
  RAISE NOTICE '[D-509 final] §b game_total OVER conf>=80:';
  FOR r IN
    SELECT count(*) AS n, max(confidence) AS max_c
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date=(NOW() AT TIME ZONE 'America/New_York')::DATE
      AND pick_side='over' AND confidence >= 80
      AND mlb_market_type='game_total'
  LOOP
    RAISE NOTICE '  n=% max_c=%', r.n, r.max_c;
    IF r.n = 0 THEN RAISE NOTICE '  → ZERO rows ✓ game_total CAPPED'; END IF;
  END LOOP;

  -- §c Carve-outs (batter_rbis + batter_hr OVER +150+ conf>=80) — MUST exist if data supports
  RAISE NOTICE '[D-509 final] §c CARVE-OUTS preserved (batter_rbis + batter_hr OVER +150+):';
  FOR r IN
    SELECT mlb_market_type, count(*) AS n,
           min(confidence) AS min_c, max(confidence) AS max_c,
           array_agg(player_name ORDER BY confidence DESC) FILTER (WHERE confidence >= 80) AS sample
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date=(NOW() AT TIME ZONE 'America/New_York')::DATE
      AND pick_side='over' AND confidence >= 80 AND odds >= 150
      AND mlb_market_type IN ('batter_rbis','batter_hr')
    GROUP BY mlb_market_type
  LOOP RAISE NOTICE '  market=% n=% min_c=% max_c=% sample=%',
    r.mlb_market_type, r.n, r.min_c, r.max_c, r.sample; END LOOP;

  -- §d Non-cluster ELITE/STRONG (favorites, unders, etc.) — must remain
  RAISE NOTICE '[D-509 final] §d NON-CLUSTER ELITE/STRONG (n by market):';
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
          (odds >= 150 AND mlb_market_type NOT IN ('batter_rbis','batter_hr'))
          OR mlb_market_type='game_total'
        )
      )
    GROUP BY mlb_market_type, pick_side, band
    ORDER BY n DESC LIMIT 25
  LOOP RAISE NOTICE '  market=% side=% band=% n=% min_c=% max_c=%',
    r.mlb_market_type, r.pick_side, r.band, r.n, r.min_c, r.max_c; END LOOP;

  -- §e Pre/post comparison on yesterday's similar matchups
  RAISE NOTICE '[D-509 final] §e cluster picks count today vs yesterday:';
  FOR r IN
    SELECT game_date,
           count(*) FILTER (WHERE pick_side='over' AND confidence >= 80 AND odds >= 150
                              AND mlb_market_type NOT IN ('batter_rbis','batter_hr')) AS cluster_excl_carveout,
           count(*) FILTER (WHERE pick_side='over' AND confidence >= 80
                              AND mlb_market_type='game_total') AS game_total_over_80,
           count(*) FILTER (WHERE confidence >= 80) AS total_elite_strong
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date IN (
        (NOW() AT TIME ZONE 'America/New_York')::DATE,
        (NOW() AT TIME ZONE 'America/New_York')::DATE - 1
      )
    GROUP BY game_date ORDER BY game_date DESC
  LOOP RAISE NOTICE '  gd=% cluster_excl_carveout=% game_total_over_80=% total_ES=%',
    r.game_date, r.cluster_excl_carveout, r.game_total_over_80, r.total_elite_strong; END LOOP;

  -- §f Error_log clean check
  RAISE NOTICE '[D-509 final] §f process-games-mlb error_log last 10 min (non-checkpoint):';
  FOR r IN
    SELECT created_at, error_type, left(error_message, 150) AS msg
    FROM public.error_log
    WHERE created_at > NOW() - INTERVAL '10 minutes'
      AND function_name='process-games-mlb'
      AND error_type NOT IN ('checkpoint','splits_cache_miss')
    ORDER BY created_at DESC LIMIT 10
  LOOP RAISE NOTICE '  at=% type=% msg=%', r.created_at, r.error_type, r.msg; END LOOP;
END $$;

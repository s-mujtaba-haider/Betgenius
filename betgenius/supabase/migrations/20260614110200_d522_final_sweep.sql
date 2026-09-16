-- D-522 SHIP 3 — final 57014-class sweep. EXPLAIN ANALYZE every
-- pick_history REST read that survived prior sweeps to definitively
-- close the class.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  -- §F.1 — CalibrationSection.tsx:122 (synthetic backfill, no LIMIT)
  RAISE NOTICE '[D-522 §F.1] CalibrationSection synthetic backfill (no LIMIT):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT confidence, hit
    FROM public.pick_history
    WHERE is_synthetic=true AND source='backfill'
      AND game_date >= '2026-05-04'::date
      AND hit IS NOT NULL AND voided=false
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- §F.2 — Games.tsx:313 (spread picks ATS_LOOKBACK_DAYS=60)
  RAISE NOTICE '[D-522 §F.2] Games.tsx spread-ATS read (MLB, 60d):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT team, opponent, pick_side, hit, game_date
    FROM public.pick_history
    WHERE prop_type='spread' AND sport='mlb' AND voided=false
      AND hit IS NOT NULL
      AND game_date >= '2026-04-15'::date
    ORDER BY game_date DESC
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- §F.3 — Performance.tsx:1250 (30d elite, post-D-521 sweep — re-check)
  RAISE NOTICE '[D-522 §F.3] Performance 30d elite read (post-D-521):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT hit, coin_flip_flag, negative_stacking_flag, unbettable_juice_flag,
           is_secondary_market, is_d214_quarantined
    FROM public.pick_history
    WHERE sport='mlb' AND confidence>=80 AND is_synthetic=false
      AND source='process-games-mlb'
      AND created_at >= (now() - interval '30 days')
      AND voided=false
    LIMIT 10000
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- §F.4 — Admin.tsx:1965 (most recent resolved_at sentinel)
  RAISE NOTICE '[D-522 §F.4] Admin most-recent resolved_at:';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT resolved_at FROM public.pick_history
    WHERE resolved_at IS NOT NULL
    ORDER BY resolved_at DESC LIMIT 1
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- §F.5 — Performance.tsx:433 (tonight's pending picks, single day)
  RAISE NOTICE '[D-522 §F.5] Performance pending-picks today:';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT id, player_name, prop_type, line, pick_side, confidence, odds
    FROM public.pick_history
    WHERE sport='mlb' AND game_date = '20260614'
      AND voided IS NOT TRUE
      AND hit IS NULL
      AND recommendation_shown=true
    ORDER BY confidence DESC LIMIT 12
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- §F.6 — Games.tsx:275 (recommendations_cache single day + sport)
  RAISE NOTICE '[D-522 §F.6] Games recommendations_cache single-day:';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT id, game_id, prop_type, pick_side, confidence
    FROM public.recommendations_cache
    WHERE game_date='20260614' AND sport='mlb'
      AND prop_type IN ('spread','game_total','spreads','totals','h2h')
    ORDER BY game_time ASC
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- §F.7 — SelectionBiasSection.tsx (organic post-may-4 with limit=5000)
  RAISE NOTICE '[D-522 §F.7] SelectionBias organic picks (capped 5000):';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT id, confidence, hit
    FROM public.pick_history
    WHERE source='process-games' AND is_synthetic=false
      AND game_date >= '2026-05-04'::date
      AND hit IS NOT NULL AND voided=false
    ORDER BY game_date DESC LIMIT 5000
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;
END $$;

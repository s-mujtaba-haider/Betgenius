-- Compare OLD vs NEW synthetic for May 7 — isolates Fix #2 (and #1, #3)
-- effects when cache_opponent_defensive_stats DOES have full BDL coverage.

DO $$
DECLARE
  r RECORD;
  new_run_id UUID;
  matched_count INT;
BEGIN
  -- Wait check: ensure new run materialized
  SELECT id INTO new_run_id FROM backfill_runs
  WHERE algorithm_version = '2026-05-11-phase2-verify-may7' LIMIT 1;

  RAISE NOTICE 'new May 7 run_id: %', new_run_id;

  IF new_run_id IS NULL THEN
    RAISE NOTICE 'May 7 run not found yet — backfill may still be processing.';
    RETURN;
  END IF;

  -- Direct comparison: backfill-may7-9-organic (pre-fix replay) vs new synthetic (post-fix)
  CREATE TEMP TABLE may7_pairs AS
  SELECT
    LOWER(old.player_name) AS norm_name, old.prop_type, old.line, old.pick_side,
    old.confidence AS old_conf, new.confidence AS new_conf,
    (new.confidence - old.confidence) AS delta_conf,
    old.score_stale_data AS old_stale, new.score_stale_data AS new_stale,
    old.score_opp_defense AS old_opp_def, new.score_opp_defense AS new_opp_def,
    old.score_trivial_line_penalty AS old_triv, new.score_trivial_line_penalty AS new_triv,
    old.odds AS old_odds, new.odds AS new_odds
  FROM pick_history old
  JOIN pick_history new
    ON LOWER(old.player_name) = LOWER(new.player_name)
   AND old.prop_type = new.prop_type
   AND old.line = new.line
   AND old.pick_side = new.pick_side
   AND old.game_date = new.game_date
  WHERE old.source = 'backfill-may7-9-organic'
    AND new.backfill_run_id = new_run_id
    AND old.game_date = '2026-05-07'::DATE
    AND old.prop_type NOT IN ('spread','game_total');

  SELECT COUNT(*) INTO matched_count FROM may7_pairs;
  RAISE NOTICE '';
  RAISE NOTICE 'May 7 OLD-vs-NEW synthetic pairs: %', matched_count;

  RAISE NOTICE '';
  RAISE NOTICE '=== May 7: confidence delta (new - old) ===';
  FOR r IN
    SELECT
      ROUND(AVG(delta_conf)::NUMERIC, 2) AS mean,
      ROUND(STDDEV(delta_conf)::NUMERIC, 2) AS std,
      MIN(delta_conf) AS mn, MAX(delta_conf) AS mx,
      COUNT(*) FILTER (WHERE delta_conf = 0) AS exact,
      COUNT(*) FILTER (WHERE ABS(delta_conf) > 5) AS gt5,
      COUNT(*) AS n
    FROM may7_pairs
  LOOP
    RAISE NOTICE 'mean=% std=% min=% max=% exact=% |Δ|>5: % n=%',
      r.mean, r.std, r.mn, r.mx, r.exact, r.gt5, r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== May 7: per-target-factor drift OLD vs NEW (synthetic only) ===';
  FOR r IN
    SELECT 'score_stale_data' AS factor,
      ROUND(AVG(ABS(new_stale - old_stale))::NUMERIC, 3) AS mean_abs_diff,
      COUNT(*) FILTER (WHERE new_stale != old_stale) AS changed
    FROM may7_pairs
    UNION ALL
    SELECT 'score_opp_defense',
      ROUND(AVG(ABS(new_opp_def - old_opp_def))::NUMERIC, 3),
      COUNT(*) FILTER (WHERE new_opp_def != old_opp_def)
    FROM may7_pairs
    UNION ALL
    SELECT 'score_trivial_pen',
      ROUND(AVG(ABS(new_triv - old_triv))::NUMERIC, 3),
      COUNT(*) FILTER (WHERE new_triv != old_triv)
    FROM may7_pairs
  LOOP
    RAISE NOTICE '% mean_abs_change=% pairs_changed=%',
      RPAD(r.factor, 20), r.mean_abs_diff, r.changed;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== May 7: odds preservation OLD vs NEW ===';
  FOR r IN
    SELECT
      COUNT(*) FILTER (WHERE old_odds = new_odds) AS same_odds,
      COUNT(*) FILTER (WHERE old_odds != new_odds) AS different_odds,
      COUNT(*) AS total
    FROM may7_pairs
  LOOP
    RAISE NOTICE 'same_odds=% different=% / %',
      r.same_odds, r.different_odds, r.total;
  END LOOP;
END $$;

DO $$
DECLARE
  r RECORD;
  phase2_run UUID := '5f9ab492-2110-423b-b028-70bce6cdd64c';
  phase3d_run UUID;
  cnt INT;
BEGIN
  SELECT id INTO phase3d_run FROM backfill_runs
  WHERE algorithm_version = '2026-05-11-phase3d-verify' LIMIT 1;
  RAISE NOTICE 'Phase 3d run_id: %', phase3d_run;
  IF phase3d_run IS NULL THEN RAISE NOTICE 'Not materialized'; RETURN; END IF;

  SELECT COUNT(*) INTO cnt FROM pick_history WHERE backfill_run_id = phase3d_run;
  RAISE NOTICE 'P3d rows: %', cnt;

  -- Quick check: are P3d player_injury scores all 0 now?
  RAISE NOTICE '';
  RAISE NOTICE '=== P3d player_injury raw values ===';
  FOR r IN
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE score_player_injury = 0) AS zero,
      COUNT(*) FILTER (WHERE score_player_injury != 0) AS nonzero,
      MIN(score_player_injury) AS mn, MAX(score_player_injury) AS mx
    FROM pick_history WHERE backfill_run_id = phase3d_run
  LOOP
    RAISE NOTICE 'total=% zero=% nonzero=% min=% max=%', r.total, r.zero, r.nonzero, r.mn, r.mx;
  END LOOP;

  -- Same for P2 (pre-fix) for contrast
  RAISE NOTICE '';
  RAISE NOTICE '=== P2 (pre-fix) player_injury raw values ===';
  FOR r IN
    SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE score_player_injury = 0) AS zero,
      COUNT(*) FILTER (WHERE score_player_injury != 0) AS nonzero,
      MIN(score_player_injury) AS mn, MAX(score_player_injury) AS mx
    FROM pick_history WHERE backfill_run_id = phase2_run
  LOOP
    RAISE NOTICE 'total=% zero=% nonzero=% min=% max=%', r.total, r.zero, r.nonzero, r.mn, r.mx;
  END LOOP;

  -- Drift comparison
  CREATE TEMP TABLE tw AS
  SELECT
    live.score_player_injury AS L_inj, p2.score_player_injury AS P2_inj, p3.score_player_injury AS P3_inj,
    live.score_usg_rate AS L_usg, p2.score_usg_rate AS P2_usg, p3.score_usg_rate AS P3_usg,
    live.score_minutes_volume AS L_mv, p2.score_minutes_volume AS P2_mv, p3.score_minutes_volume AS P3_mv,
    live.score_minutes_stability AS L_ms, p2.score_minutes_stability AS P2_ms, p3.score_minutes_stability AS P3_ms,
    live.score_rest AS L_rest, p2.score_rest AS P2_rest, p3.score_rest AS P3_rest,
    live.score_b2b AS L_b2b, p2.score_b2b AS P2_b2b, p3.score_b2b AS P3_b2b,
    live.confidence AS live_conf, p2.confidence AS p2_conf, p3.confidence AS p3_conf
  FROM pick_history live
  JOIN pick_history p2 USING (player_name, prop_type, line, pick_side, game_date)
  JOIN pick_history p3 USING (player_name, prop_type, line, pick_side, game_date)
  WHERE live.source = 'process-games' AND live.is_synthetic = false
    AND p2.backfill_run_id = phase2_run
    AND p3.backfill_run_id = phase3d_run
    AND live.game_date = '2026-04-25'::DATE
    AND live.prop_type NOT IN ('spread','game_total');

  RAISE NOTICE '';
  RAISE NOTICE '=== Per-factor drift P2 vs P3d ===';
  FOR r IN
    SELECT 'player_injury P2' f, ROUND(AVG(ABS(L_inj - P2_inj))::NUMERIC,3) m, COUNT(*) FILTER (WHERE L_inj!=P2_inj) nz FROM tw
    UNION ALL SELECT 'player_injury P3d', ROUND(AVG(ABS(L_inj - P3_inj))::NUMERIC,3), COUNT(*) FILTER (WHERE L_inj!=P3_inj) FROM tw
    UNION ALL SELECT 'usg_rate      P2', ROUND(AVG(ABS(L_usg - P2_usg))::NUMERIC,3), COUNT(*) FILTER (WHERE L_usg!=P2_usg) FROM tw
    UNION ALL SELECT 'usg_rate      P3d', ROUND(AVG(ABS(L_usg - P3_usg))::NUMERIC,3), COUNT(*) FILTER (WHERE L_usg!=P3_usg) FROM tw
    UNION ALL SELECT 'mins_volume   P2', ROUND(AVG(ABS(L_mv - P2_mv))::NUMERIC,3), COUNT(*) FILTER (WHERE L_mv!=P2_mv) FROM tw
    UNION ALL SELECT 'mins_volume   P3d', ROUND(AVG(ABS(L_mv - P3_mv))::NUMERIC,3), COUNT(*) FILTER (WHERE L_mv!=P3_mv) FROM tw
    UNION ALL SELECT 'mins_stab     P2', ROUND(AVG(ABS(L_ms - P2_ms))::NUMERIC,3), COUNT(*) FILTER (WHERE L_ms!=P2_ms) FROM tw
    UNION ALL SELECT 'mins_stab     P3d', ROUND(AVG(ABS(L_ms - P3_ms))::NUMERIC,3), COUNT(*) FILTER (WHERE L_ms!=P3_ms) FROM tw
    UNION ALL SELECT 'rest          P2', ROUND(AVG(ABS(L_rest - P2_rest))::NUMERIC,3), COUNT(*) FILTER (WHERE L_rest!=P2_rest) FROM tw
    UNION ALL SELECT 'rest          P3d', ROUND(AVG(ABS(L_rest - P3_rest))::NUMERIC,3), COUNT(*) FILTER (WHERE L_rest!=P3_rest) FROM tw
    UNION ALL SELECT 'b2b           P2', ROUND(AVG(ABS(L_b2b - P2_b2b))::NUMERIC,3), COUNT(*) FILTER (WHERE L_b2b!=P2_b2b) FROM tw
    UNION ALL SELECT 'b2b           P3d', ROUND(AVG(ABS(L_b2b - P3_b2b))::NUMERIC,3), COUNT(*) FILTER (WHERE L_b2b!=P3_b2b) FROM tw
  LOOP RAISE NOTICE '% mean_abs=% nz=%', r.f, r.m, r.nz; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== Confidence delta + 70-79 WR ===';
  FOR r IN
    SELECT 'PHASE 2' l, ROUND(AVG(live_conf - p2_conf)::NUMERIC, 2) AS mean, COUNT(*) FILTER (WHERE ABS(live_conf - p2_conf) > 5) AS gt5 FROM tw
    UNION ALL SELECT 'PHASE 3d', ROUND(AVG(live_conf - p3_conf)::NUMERIC, 2), COUNT(*) FILTER (WHERE ABS(live_conf - p3_conf) > 5) FROM tw
    ORDER BY 1
  LOOP RAISE NOTICE '% mean_delta=% |Δ|>5: %', r.l, r.mean, r.gt5; END LOOP;

  FOR r IN
    SELECT 'P3d 70-79 WR' AS l, COUNT(*) AS n, SUM(CASE WHEN hit THEN 1 ELSE 0 END) AS h,
      ROUND(100.0 * SUM(CASE WHEN hit THEN 1 ELSE 0 END) / NULLIF(SUM(CASE WHEN hit IS NOT NULL THEN 1 ELSE 0 END), 0), 2) AS wr
    FROM pick_history WHERE backfill_run_id = phase3d_run AND game_date = '2026-04-25'::DATE
      AND prop_type NOT IN ('spread','game_total') AND confidence >= 70 AND confidence < 80
  LOOP RAISE NOTICE '% n=% hits=% wr=%', r.l, r.n, r.h, r.wr; END LOOP;
END $$;

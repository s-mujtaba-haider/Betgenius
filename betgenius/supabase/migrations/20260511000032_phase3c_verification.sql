DO $$
DECLARE
  r RECORD;
  phase2_run UUID := '5f9ab492-2110-423b-b028-70bce6cdd64c';
  phase3c_run UUID;
BEGIN
  SELECT id INTO phase3c_run FROM backfill_runs
  WHERE algorithm_version = '2026-05-11-phase3c-verify' LIMIT 1;
  RAISE NOTICE 'Phase 3c run_id: %', phase3c_run;
  IF phase3c_run IS NULL THEN RAISE NOTICE 'Not materialized yet'; RETURN; END IF;

  CREATE TEMP TABLE tw AS
  SELECT
    LOWER(live.player_name) AS norm_name, live.prop_type, live.line, live.pick_side,
    live.confidence AS live_conf, p2.confidence AS p2_conf, p3.confidence AS p3_conf,
    (live.confidence - p2.confidence) AS p2_delta,
    (live.confidence - p3.confidence) AS p3_delta,
    live.score_stale_data AS L_stale, p2.score_stale_data AS P2_stale, p3.score_stale_data AS P3_stale,
    live.score_opp_defense AS L_opp, p2.score_opp_defense AS P2_opp, p3.score_opp_defense AS P3_opp,
    live.score_trivial_line_penalty AS L_triv, p2.score_trivial_line_penalty AS P2_triv, p3.score_trivial_line_penalty AS P3_triv,
    live.score_rest AS L_rest, p2.score_rest AS P2_rest, p3.score_rest AS P3_rest,
    live.score_b2b AS L_b2b, p2.score_b2b AS P2_b2b, p3.score_b2b AS P3_b2b,
    live.score_player_injury AS L_inj, p2.score_player_injury AS P2_inj, p3.score_player_injury AS P3_inj,
    live.score_usg_rate AS L_usg, p2.score_usg_rate AS P2_usg, p3.score_usg_rate AS P3_usg,
    live.score_minutes_volume AS L_mv, p2.score_minutes_volume AS P2_mv, p3.score_minutes_volume AS P3_mv,
    live.score_minutes_stability AS L_ms, p2.score_minutes_stability AS P2_ms, p3.score_minutes_stability AS P3_ms,
    live.score_minutes_trend AS L_mt, p2.score_minutes_trend AS P2_mt, p3.score_minutes_trend AS P3_mt,
    live.score_pace AS L_pace, p2.score_pace AS P2_pace, p3.score_pace AS P3_pace,
    live.score_home_away AS L_ha, p2.score_home_away AS P2_ha, p3.score_home_away AS P3_ha
  FROM pick_history live
  JOIN pick_history p2 USING (player_name, prop_type, line, pick_side, game_date)
  JOIN pick_history p3 USING (player_name, prop_type, line, pick_side, game_date)
  WHERE live.source = 'process-games' AND live.is_synthetic = false
    AND p2.backfill_run_id = phase2_run
    AND p3.backfill_run_id = phase3c_run
    AND live.game_date = '2026-04-25'::DATE
    AND live.prop_type NOT IN ('spread','game_total');

  RAISE NOTICE '=== Confidence delta (live − synthetic) ===';
  FOR r IN
    SELECT 'PHASE 2' AS l, ROUND(AVG(p2_delta)::NUMERIC,2) AS mean, ROUND(STDDEV(p2_delta)::NUMERIC,2) AS std,
      COUNT(*) FILTER (WHERE ABS(p2_delta)>5) AS gt5, COUNT(*) FILTER (WHERE ABS(p2_delta)>10) AS gt10, COUNT(*) AS n FROM tw
    UNION ALL SELECT 'PHASE 3c', ROUND(AVG(p3_delta)::NUMERIC,2), ROUND(STDDEV(p3_delta)::NUMERIC,2),
      COUNT(*) FILTER (WHERE ABS(p3_delta)>5), COUNT(*) FILTER (WHERE ABS(p3_delta)>10), COUNT(*) FROM tw
    ORDER BY 1
  LOOP RAISE NOTICE '% mean=% std=% |Δ|>5: % |Δ|>10: % n=%', r.l, r.mean, r.std, r.gt5, r.gt10, r.n; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== Per-factor mean abs drift ===';
  FOR r IN
    SELECT 'stale_data    P2' f, ROUND(AVG(ABS(L_stale - P2_stale))::NUMERIC,3) m, COUNT(*) FILTER (WHERE L_stale!=P2_stale) nz FROM tw
    UNION ALL SELECT 'stale_data    P3c', ROUND(AVG(ABS(L_stale - P3_stale))::NUMERIC,3), COUNT(*) FILTER (WHERE L_stale!=P3_stale) FROM tw
    UNION ALL SELECT 'opp_defense   P2', ROUND(AVG(ABS(L_opp - P2_opp))::NUMERIC,3), COUNT(*) FILTER (WHERE L_opp!=P2_opp) FROM tw
    UNION ALL SELECT 'opp_defense   P3c', ROUND(AVG(ABS(L_opp - P3_opp))::NUMERIC,3), COUNT(*) FILTER (WHERE L_opp!=P3_opp) FROM tw
    UNION ALL SELECT 'trivial_pen   P2', ROUND(AVG(ABS(L_triv - P2_triv))::NUMERIC,3), COUNT(*) FILTER (WHERE L_triv!=P2_triv) FROM tw
    UNION ALL SELECT 'trivial_pen   P3c', ROUND(AVG(ABS(L_triv - P3_triv))::NUMERIC,3), COUNT(*) FILTER (WHERE L_triv!=P3_triv) FROM tw
    UNION ALL SELECT 'rest          P2', ROUND(AVG(ABS(L_rest - P2_rest))::NUMERIC,3), COUNT(*) FILTER (WHERE L_rest!=P2_rest) FROM tw
    UNION ALL SELECT 'rest          P3c', ROUND(AVG(ABS(L_rest - P3_rest))::NUMERIC,3), COUNT(*) FILTER (WHERE L_rest!=P3_rest) FROM tw
    UNION ALL SELECT 'b2b           P2', ROUND(AVG(ABS(L_b2b - P2_b2b))::NUMERIC,3), COUNT(*) FILTER (WHERE L_b2b!=P2_b2b) FROM tw
    UNION ALL SELECT 'b2b           P3c', ROUND(AVG(ABS(L_b2b - P3_b2b))::NUMERIC,3), COUNT(*) FILTER (WHERE L_b2b!=P3_b2b) FROM tw
    UNION ALL SELECT 'player_injury P2', ROUND(AVG(ABS(L_inj - P2_inj))::NUMERIC,3), COUNT(*) FILTER (WHERE L_inj!=P2_inj) FROM tw
    UNION ALL SELECT 'player_injury P3c', ROUND(AVG(ABS(L_inj - P3_inj))::NUMERIC,3), COUNT(*) FILTER (WHERE L_inj!=P3_inj) FROM tw
    UNION ALL SELECT 'usg_rate      P2', ROUND(AVG(ABS(L_usg - P2_usg))::NUMERIC,3), COUNT(*) FILTER (WHERE L_usg!=P2_usg) FROM tw
    UNION ALL SELECT 'usg_rate      P3c', ROUND(AVG(ABS(L_usg - P3_usg))::NUMERIC,3), COUNT(*) FILTER (WHERE L_usg!=P3_usg) FROM tw
    UNION ALL SELECT 'mins_volume   P2', ROUND(AVG(ABS(L_mv - P2_mv))::NUMERIC,3), COUNT(*) FILTER (WHERE L_mv!=P2_mv) FROM tw
    UNION ALL SELECT 'mins_volume   P3c', ROUND(AVG(ABS(L_mv - P3_mv))::NUMERIC,3), COUNT(*) FILTER (WHERE L_mv!=P3_mv) FROM tw
    UNION ALL SELECT 'mins_stab     P2', ROUND(AVG(ABS(L_ms - P2_ms))::NUMERIC,3), COUNT(*) FILTER (WHERE L_ms!=P2_ms) FROM tw
    UNION ALL SELECT 'mins_stab     P3c', ROUND(AVG(ABS(L_ms - P3_ms))::NUMERIC,3), COUNT(*) FILTER (WHERE L_ms!=P3_ms) FROM tw
    UNION ALL SELECT 'mins_trend    P2', ROUND(AVG(ABS(L_mt - P2_mt))::NUMERIC,3), COUNT(*) FILTER (WHERE L_mt!=P2_mt) FROM tw
    UNION ALL SELECT 'mins_trend    P3c', ROUND(AVG(ABS(L_mt - P3_mt))::NUMERIC,3), COUNT(*) FILTER (WHERE L_mt!=P3_mt) FROM tw
    UNION ALL SELECT 'pace          P2', ROUND(AVG(ABS(L_pace - P2_pace))::NUMERIC,3), COUNT(*) FILTER (WHERE L_pace!=P2_pace) FROM tw
    UNION ALL SELECT 'pace          P3c', ROUND(AVG(ABS(L_pace - P3_pace))::NUMERIC,3), COUNT(*) FILTER (WHERE L_pace!=P3_pace) FROM tw
    UNION ALL SELECT 'home_away     P2', ROUND(AVG(ABS(L_ha - P2_ha))::NUMERIC,3), COUNT(*) FILTER (WHERE L_ha!=P2_ha) FROM tw
    UNION ALL SELECT 'home_away     P3c', ROUND(AVG(ABS(L_ha - P3_ha))::NUMERIC,3), COUNT(*) FILTER (WHERE L_ha!=P3_ha) FROM tw
  LOOP RAISE NOTICE '% mean_abs=% nz=%', r.f, r.m, r.nz; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== 70-79 WR ===';
  FOR r IN
    SELECT 'live' AS l, COUNT(*) AS n, SUM(CASE WHEN hit THEN 1 ELSE 0 END) AS h,
      ROUND(100.0 * SUM(CASE WHEN hit THEN 1 ELSE 0 END) / NULLIF(SUM(CASE WHEN hit IS NOT NULL THEN 1 ELSE 0 END), 0), 2) AS wr
    FROM pick_history WHERE source = 'process-games' AND is_synthetic = false
      AND game_date = '2026-04-25'::DATE AND prop_type NOT IN ('spread','game_total')
      AND confidence >= 70 AND confidence < 80
    UNION ALL SELECT 'P2 syn', COUNT(*), SUM(CASE WHEN hit THEN 1 ELSE 0 END),
      ROUND(100.0 * SUM(CASE WHEN hit THEN 1 ELSE 0 END) / NULLIF(SUM(CASE WHEN hit IS NOT NULL THEN 1 ELSE 0 END), 0), 2)
    FROM pick_history WHERE backfill_run_id = phase2_run AND game_date = '2026-04-25'::DATE
      AND prop_type NOT IN ('spread','game_total') AND confidence >= 70 AND confidence < 80
    UNION ALL SELECT 'P3c syn', COUNT(*), SUM(CASE WHEN hit THEN 1 ELSE 0 END),
      ROUND(100.0 * SUM(CASE WHEN hit THEN 1 ELSE 0 END) / NULLIF(SUM(CASE WHEN hit IS NOT NULL THEN 1 ELSE 0 END), 0), 2)
    FROM pick_history WHERE backfill_run_id = phase3c_run AND game_date = '2026-04-25'::DATE
      AND prop_type NOT IN ('spread','game_total') AND confidence >= 70 AND confidence < 80
  LOOP RAISE NOTICE '% n=% hits=% wr=%', RPAD(r.l,10), r.n, r.h, r.wr; END LOOP;
END $$;

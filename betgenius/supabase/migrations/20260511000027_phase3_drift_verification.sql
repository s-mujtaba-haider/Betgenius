-- Phase 3 drift verification — compare Phase 2 fixed synthetic vs Phase 3
-- fixed synthetic for 2026-04-25, both against live process-games.

DO $$
DECLARE
  r RECORD;
  phase2_run UUID := '5f9ab492-2110-423b-b028-70bce6cdd64c';  -- from Phase 2 commit history
  phase3_run UUID;
  cnt INT;
BEGIN
  SELECT id INTO phase3_run FROM backfill_runs
  WHERE algorithm_version = '2026-05-11-phase3-verify' LIMIT 1;
  RAISE NOTICE 'Phase 3 run_id: %', phase3_run;

  IF phase3_run IS NULL THEN
    RAISE NOTICE 'Phase 3 run not yet materialized — aborting comparison.';
    RETURN;
  END IF;

  SELECT COUNT(*) INTO cnt FROM pick_history WHERE backfill_run_id = phase3_run;
  RAISE NOTICE 'Phase 3 synthetic rows written: %', cnt;

  -- Three-way matched join: live × Phase 2 synthetic × Phase 3 synthetic
  CREATE TEMP TABLE three_way AS
  SELECT
    LOWER(live.player_name) AS norm_name, live.prop_type, live.line, live.pick_side,
    live.confidence AS live_conf,
    p2.confidence AS p2_conf,
    p3.confidence AS p3_conf,
    (live.confidence - p2.confidence) AS p2_delta,
    (live.confidence - p3.confidence) AS p3_delta,
    -- Per-factor drift for all 12 Phase 1 factors
    live.score_stale_data       AS L_stale,    p2.score_stale_data       AS P2_stale,    p3.score_stale_data       AS P3_stale,
    live.score_opp_defense      AS L_opp,      p2.score_opp_defense      AS P2_opp,      p3.score_opp_defense      AS P3_opp,
    live.score_trivial_line_penalty AS L_triv, p2.score_trivial_line_penalty AS P2_triv, p3.score_trivial_line_penalty AS P3_triv,
    live.score_rest             AS L_rest,     p2.score_rest             AS P2_rest,     p3.score_rest             AS P3_rest,
    live.score_b2b              AS L_b2b,      p2.score_b2b              AS P2_b2b,      p3.score_b2b              AS P3_b2b,
    live.score_player_injury    AS L_inj,      p2.score_player_injury    AS P2_inj,      p3.score_player_injury    AS P3_inj,
    live.score_usg_rate         AS L_usg,      p2.score_usg_rate         AS P2_usg,      p3.score_usg_rate         AS P3_usg,
    live.score_minutes_volume   AS L_mv,       p2.score_minutes_volume   AS P2_mv,       p3.score_minutes_volume   AS P3_mv,
    live.score_minutes_stability AS L_ms,      p2.score_minutes_stability AS P2_ms,      p3.score_minutes_stability AS P3_ms,
    live.score_minutes_trend    AS L_mt,       p2.score_minutes_trend    AS P2_mt,       p3.score_minutes_trend    AS P3_mt,
    live.score_pace             AS L_pace,     p2.score_pace             AS P2_pace,     p3.score_pace             AS P3_pace,
    live.score_home_away        AS L_ha,       p2.score_home_away        AS P2_ha,       p3.score_home_away        AS P3_ha
  FROM pick_history live
  JOIN pick_history p2 USING (player_name, prop_type, line, pick_side, game_date)
  JOIN pick_history p3 USING (player_name, prop_type, line, pick_side, game_date)
  WHERE live.source = 'process-games' AND live.is_synthetic = false
    AND p2.backfill_run_id = phase2_run
    AND p3.backfill_run_id = phase3_run
    AND live.game_date = '2026-04-25'::DATE
    AND live.prop_type NOT IN ('spread','game_total');

  SELECT COUNT(*) INTO cnt FROM three_way;
  RAISE NOTICE 'Three-way matched pairs (live × P2 × P3): %', cnt;

  -- Confidence delta distribution Phase 2 vs Phase 3
  RAISE NOTICE '';
  RAISE NOTICE '=== Confidence delta distribution (live − synthetic) ===';
  FOR r IN
    SELECT 'PHASE 2' AS label,
      ROUND(AVG(p2_delta)::NUMERIC, 2) AS mean,
      ROUND(STDDEV(p2_delta)::NUMERIC, 2) AS std,
      MIN(p2_delta) AS mn, MAX(p2_delta) AS mx,
      COUNT(*) FILTER (WHERE p2_delta = 0) AS exact,
      COUNT(*) FILTER (WHERE ABS(p2_delta) > 5) AS gt5,
      COUNT(*) FILTER (WHERE ABS(p2_delta) > 10) AS gt10,
      COUNT(*) AS n
    FROM three_way
    UNION ALL
    SELECT 'PHASE 3',
      ROUND(AVG(p3_delta)::NUMERIC, 2),
      ROUND(STDDEV(p3_delta)::NUMERIC, 2),
      MIN(p3_delta), MAX(p3_delta),
      COUNT(*) FILTER (WHERE p3_delta = 0),
      COUNT(*) FILTER (WHERE ABS(p3_delta) > 5),
      COUNT(*) FILTER (WHERE ABS(p3_delta) > 10),
      COUNT(*)
    FROM three_way
    ORDER BY 1
  LOOP
    RAISE NOTICE '% mean=% std=% min=% max=% exact=% |Δ|>5: % |Δ|>10: % n=%',
      r.label, r.mean, r.std, r.mn, r.mx, r.exact, r.gt5, r.gt10, r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== Per-factor mean abs drift Phase 2 vs Phase 3 (vs live) ===';
  FOR r IN
    SELECT 'stale_data       P2' AS f, ROUND(AVG(ABS(L_stale - P2_stale))::NUMERIC, 3) AS m, COUNT(*) FILTER (WHERE L_stale != P2_stale) AS nz FROM three_way
    UNION ALL SELECT 'stale_data       P3', ROUND(AVG(ABS(L_stale - P3_stale))::NUMERIC, 3), COUNT(*) FILTER (WHERE L_stale != P3_stale) FROM three_way
    UNION ALL SELECT 'opp_defense      P2', ROUND(AVG(ABS(L_opp   - P2_opp  ))::NUMERIC, 3), COUNT(*) FILTER (WHERE L_opp   != P2_opp  ) FROM three_way
    UNION ALL SELECT 'opp_defense      P3', ROUND(AVG(ABS(L_opp   - P3_opp  ))::NUMERIC, 3), COUNT(*) FILTER (WHERE L_opp   != P3_opp  ) FROM three_way
    UNION ALL SELECT 'trivial_pen      P2', ROUND(AVG(ABS(L_triv  - P2_triv ))::NUMERIC, 3), COUNT(*) FILTER (WHERE L_triv  != P2_triv ) FROM three_way
    UNION ALL SELECT 'trivial_pen      P3', ROUND(AVG(ABS(L_triv  - P3_triv ))::NUMERIC, 3), COUNT(*) FILTER (WHERE L_triv  != P3_triv ) FROM three_way
    UNION ALL SELECT 'rest             P2', ROUND(AVG(ABS(L_rest  - P2_rest ))::NUMERIC, 3), COUNT(*) FILTER (WHERE L_rest  != P2_rest ) FROM three_way
    UNION ALL SELECT 'rest             P3', ROUND(AVG(ABS(L_rest  - P3_rest ))::NUMERIC, 3), COUNT(*) FILTER (WHERE L_rest  != P3_rest ) FROM three_way
    UNION ALL SELECT 'b2b              P2', ROUND(AVG(ABS(L_b2b   - P2_b2b  ))::NUMERIC, 3), COUNT(*) FILTER (WHERE L_b2b   != P2_b2b  ) FROM three_way
    UNION ALL SELECT 'b2b              P3', ROUND(AVG(ABS(L_b2b   - P3_b2b  ))::NUMERIC, 3), COUNT(*) FILTER (WHERE L_b2b   != P3_b2b  ) FROM three_way
    UNION ALL SELECT 'player_injury    P2', ROUND(AVG(ABS(L_inj   - P2_inj  ))::NUMERIC, 3), COUNT(*) FILTER (WHERE L_inj   != P2_inj  ) FROM three_way
    UNION ALL SELECT 'player_injury    P3', ROUND(AVG(ABS(L_inj   - P3_inj  ))::NUMERIC, 3), COUNT(*) FILTER (WHERE L_inj   != P3_inj  ) FROM three_way
    UNION ALL SELECT 'usg_rate         P2', ROUND(AVG(ABS(L_usg   - P2_usg  ))::NUMERIC, 3), COUNT(*) FILTER (WHERE L_usg   != P2_usg  ) FROM three_way
    UNION ALL SELECT 'usg_rate         P3', ROUND(AVG(ABS(L_usg   - P3_usg  ))::NUMERIC, 3), COUNT(*) FILTER (WHERE L_usg   != P3_usg  ) FROM three_way
    UNION ALL SELECT 'minutes_volume   P2', ROUND(AVG(ABS(L_mv    - P2_mv   ))::NUMERIC, 3), COUNT(*) FILTER (WHERE L_mv    != P2_mv   ) FROM three_way
    UNION ALL SELECT 'minutes_volume   P3', ROUND(AVG(ABS(L_mv    - P3_mv   ))::NUMERIC, 3), COUNT(*) FILTER (WHERE L_mv    != P3_mv   ) FROM three_way
    UNION ALL SELECT 'minutes_stab     P2', ROUND(AVG(ABS(L_ms    - P2_ms   ))::NUMERIC, 3), COUNT(*) FILTER (WHERE L_ms    != P2_ms   ) FROM three_way
    UNION ALL SELECT 'minutes_stab     P3', ROUND(AVG(ABS(L_ms    - P3_ms   ))::NUMERIC, 3), COUNT(*) FILTER (WHERE L_ms    != P3_ms   ) FROM three_way
    UNION ALL SELECT 'minutes_trend    P2', ROUND(AVG(ABS(L_mt    - P2_mt   ))::NUMERIC, 3), COUNT(*) FILTER (WHERE L_mt    != P2_mt   ) FROM three_way
    UNION ALL SELECT 'minutes_trend    P3', ROUND(AVG(ABS(L_mt    - P3_mt   ))::NUMERIC, 3), COUNT(*) FILTER (WHERE L_mt    != P3_mt   ) FROM three_way
    UNION ALL SELECT 'pace             P2', ROUND(AVG(ABS(L_pace  - P2_pace ))::NUMERIC, 3), COUNT(*) FILTER (WHERE L_pace  != P2_pace ) FROM three_way
    UNION ALL SELECT 'pace             P3', ROUND(AVG(ABS(L_pace  - P3_pace ))::NUMERIC, 3), COUNT(*) FILTER (WHERE L_pace  != P3_pace ) FROM three_way
    UNION ALL SELECT 'home_away        P2', ROUND(AVG(ABS(L_ha    - P2_ha   ))::NUMERIC, 3), COUNT(*) FILTER (WHERE L_ha    != P2_ha   ) FROM three_way
    UNION ALL SELECT 'home_away        P3', ROUND(AVG(ABS(L_ha    - P3_ha   ))::NUMERIC, 3), COUNT(*) FILTER (WHERE L_ha    != P3_ha   ) FROM three_way
  LOOP
    RAISE NOTICE '% mean_abs=% nonzero_pairs=%', r.f, r.m, r.nz;
  END LOOP;

  -- 70-79 band WR comparison
  RAISE NOTICE '';
  RAISE NOTICE '=== 70-79 WR comparison ===';
  FOR r IN
    SELECT 'live process-games' AS label, COUNT(*) AS n,
      SUM(CASE WHEN hit THEN 1 ELSE 0 END) AS hits,
      ROUND(100.0 * SUM(CASE WHEN hit THEN 1 ELSE 0 END)
        / NULLIF(SUM(CASE WHEN hit IS NOT NULL THEN 1 ELSE 0 END), 0), 2) AS wr
    FROM pick_history WHERE source = 'process-games' AND is_synthetic = false
      AND game_date = '2026-04-25'::DATE AND prop_type NOT IN ('spread','game_total')
      AND confidence >= 70 AND confidence < 80
    UNION ALL
    SELECT 'PHASE 2 synthetic', COUNT(*),
      SUM(CASE WHEN hit THEN 1 ELSE 0 END),
      ROUND(100.0 * SUM(CASE WHEN hit THEN 1 ELSE 0 END)
        / NULLIF(SUM(CASE WHEN hit IS NOT NULL THEN 1 ELSE 0 END), 0), 2)
    FROM pick_history WHERE backfill_run_id = phase2_run
      AND game_date = '2026-04-25'::DATE AND prop_type NOT IN ('spread','game_total')
      AND confidence >= 70 AND confidence < 80
    UNION ALL
    SELECT 'PHASE 3 synthetic', COUNT(*),
      SUM(CASE WHEN hit THEN 1 ELSE 0 END),
      ROUND(100.0 * SUM(CASE WHEN hit THEN 1 ELSE 0 END)
        / NULLIF(SUM(CASE WHEN hit IS NOT NULL THEN 1 ELSE 0 END), 0), 2)
    FROM pick_history WHERE backfill_run_id = phase3_run
      AND game_date = '2026-04-25'::DATE AND prop_type NOT IN ('spread','game_total')
      AND confidence >= 70 AND confidence < 80
  LOOP
    RAISE NOTICE '% n=% hits=% wr=%', RPAD(r.label, 22), r.n, r.hits, r.wr;
  END LOOP;
END $$;

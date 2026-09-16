-- Phase 2 verification (v2) — run_id hardcoded from successful invoke.
-- Read-only. Compares OLD synthetic backfill (pre-fix) against NEW
-- synthetic backfill (post-fix) for the same date 2026-04-25.

DO $$
DECLARE
  r RECORD;
  new_run_id UUID := '5f9ab492-2110-423b-b028-70bce6cdd64c';
  matched_count_old INT;
  matched_count_new INT;
BEGIN
  -- OLD pairs: live process-games vs pre-fix backfill (source='backfill', is_synthetic=true, different algorithm_version)
  CREATE TEMP TABLE old_pairs AS
  SELECT
    LOWER(live.player_name) AS norm_name, live.prop_type, live.line, live.pick_side,
    live.confidence AS live_conf, syn.confidence AS syn_conf,
    (live.confidence - syn.confidence) AS delta_conf,
    live.score_stale_data       AS live_stale,    syn.score_stale_data       AS syn_stale,
    live.score_opp_defense      AS live_opp_def,  syn.score_opp_defense      AS syn_opp_def,
    live.score_trivial_line_penalty AS live_triv, syn.score_trivial_line_penalty AS syn_triv,
    live.odds AS live_odds, syn.odds AS syn_odds
  FROM pick_history live
  JOIN pick_history syn
    ON LOWER(live.player_name) = LOWER(syn.player_name)
   AND live.prop_type = syn.prop_type
   AND live.line = syn.line
   AND live.pick_side = syn.pick_side
   AND live.game_date = syn.game_date
  WHERE live.source = 'process-games' AND live.is_synthetic = false
    AND syn.source = 'backfill' AND syn.is_synthetic = true
    AND syn.backfill_run_id IS DISTINCT FROM new_run_id
    AND live.game_date = '2026-04-25'::DATE
    AND live.prop_type NOT IN ('spread','game_total');

  -- NEW pairs: live process-games vs post-fix backfill (the new run_id)
  CREATE TEMP TABLE new_pairs AS
  SELECT
    LOWER(live.player_name) AS norm_name, live.prop_type, live.line, live.pick_side,
    live.confidence AS live_conf, syn.confidence AS syn_conf,
    (live.confidence - syn.confidence) AS delta_conf,
    live.score_stale_data       AS live_stale,    syn.score_stale_data       AS syn_stale,
    live.score_opp_defense      AS live_opp_def,  syn.score_opp_defense      AS syn_opp_def,
    live.score_trivial_line_penalty AS live_triv, syn.score_trivial_line_penalty AS syn_triv,
    live.odds AS live_odds, syn.odds AS syn_odds
  FROM pick_history live
  JOIN pick_history syn
    ON LOWER(live.player_name) = LOWER(syn.player_name)
   AND live.prop_type = syn.prop_type
   AND live.line = syn.line
   AND live.pick_side = syn.pick_side
   AND live.game_date = syn.game_date
  WHERE live.source = 'process-games' AND live.is_synthetic = false
    AND syn.backfill_run_id = new_run_id
    AND live.game_date = '2026-04-25'::DATE
    AND live.prop_type NOT IN ('spread','game_total');

  SELECT COUNT(*) INTO matched_count_old FROM old_pairs;
  SELECT COUNT(*) INTO matched_count_new FROM new_pairs;

  RAISE NOTICE '====================================================';
  RAISE NOTICE '=== Matched pair counts for 2026-04-25 ===';
  RAISE NOTICE '====================================================';
  RAISE NOTICE 'OLD pairs (live vs pre-fix backfill): %', matched_count_old;
  RAISE NOTICE 'NEW pairs (live vs post-fix backfill, run_id=%): %', new_run_id, matched_count_new;

  RAISE NOTICE '';
  RAISE NOTICE '====================================================';
  RAISE NOTICE '=== Confidence delta: live - synthetic ===';
  RAISE NOTICE '====================================================';
  FOR r IN
    SELECT 'OLD' AS label,
      ROUND(AVG(delta_conf)::NUMERIC, 2) AS mean,
      ROUND(STDDEV(delta_conf)::NUMERIC, 2) AS std,
      MIN(delta_conf) AS mn, MAX(delta_conf) AS mx,
      COUNT(*) FILTER (WHERE delta_conf = 0)          AS exact,
      COUNT(*) FILTER (WHERE ABS(delta_conf) > 5)     AS gt5,
      COUNT(*) FILTER (WHERE ABS(delta_conf) > 10)    AS gt10,
      COUNT(*) AS n
    FROM old_pairs
    UNION ALL
    SELECT 'NEW',
      ROUND(AVG(delta_conf)::NUMERIC, 2),
      ROUND(STDDEV(delta_conf)::NUMERIC, 2),
      MIN(delta_conf), MAX(delta_conf),
      COUNT(*) FILTER (WHERE delta_conf = 0),
      COUNT(*) FILTER (WHERE ABS(delta_conf) > 5),
      COUNT(*) FILTER (WHERE ABS(delta_conf) > 10),
      COUNT(*)
    FROM new_pairs
    ORDER BY 1
  LOOP
    RAISE NOTICE '% mean=% std=% min=% max=% exact_match=% |Δ|>5: % |Δ|>10: % n=%',
      r.label, r.mean, r.std, r.mn, r.mx, r.exact, r.gt5, r.gt10, r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '====================================================';
  RAISE NOTICE '=== Per-target-factor mean abs drift, BEFORE → AFTER ===';
  RAISE NOTICE '====================================================';
  FOR r IN
    SELECT 'score_stale_data    OLD' AS label,
      ROUND(AVG(ABS(live_stale - syn_stale))::NUMERIC, 3) AS mean_abs,
      COUNT(*) FILTER (WHERE live_stale != syn_stale) AS nonzero
    FROM old_pairs
    UNION ALL
    SELECT 'score_stale_data    NEW',
      ROUND(AVG(ABS(live_stale - syn_stale))::NUMERIC, 3),
      COUNT(*) FILTER (WHERE live_stale != syn_stale) FROM new_pairs
    UNION ALL
    SELECT 'score_opp_defense   OLD',
      ROUND(AVG(ABS(live_opp_def - syn_opp_def))::NUMERIC, 3),
      COUNT(*) FILTER (WHERE live_opp_def != syn_opp_def) FROM old_pairs
    UNION ALL
    SELECT 'score_opp_defense   NEW',
      ROUND(AVG(ABS(live_opp_def - syn_opp_def))::NUMERIC, 3),
      COUNT(*) FILTER (WHERE live_opp_def != syn_opp_def) FROM new_pairs
    UNION ALL
    SELECT 'score_trivial_pen   OLD',
      ROUND(AVG(ABS(live_triv - syn_triv))::NUMERIC, 3),
      COUNT(*) FILTER (WHERE live_triv != syn_triv) FROM old_pairs
    UNION ALL
    SELECT 'score_trivial_pen   NEW',
      ROUND(AVG(ABS(live_triv - syn_triv))::NUMERIC, 3),
      COUNT(*) FILTER (WHERE live_triv != syn_triv) FROM new_pairs
  LOOP
    RAISE NOTICE '% mean_abs=% nonzero_pairs=%',
      r.label, r.mean_abs, r.nonzero;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '====================================================';
  RAISE NOTICE '=== Odds match: live.odds = syn.odds ===';
  RAISE NOTICE '====================================================';
  FOR r IN
    SELECT 'OLD' AS label,
      COUNT(*) FILTER (WHERE live_odds = syn_odds) AS match_count,
      COUNT(*) AS total
    FROM old_pairs
    UNION ALL
    SELECT 'NEW',
      COUNT(*) FILTER (WHERE live_odds = syn_odds),
      COUNT(*) FROM new_pairs
    ORDER BY 1
  LOOP
    RAISE NOTICE '% odds matching live: % / %', r.label, r.match_count, r.total;
  END LOOP;

  -- 70-79 WR comparison
  RAISE NOTICE '';
  RAISE NOTICE '====================================================';
  RAISE NOTICE '=== 70-79 band WR: live vs OLD synthetic vs NEW synthetic (2026-04-25) ===';
  RAISE NOTICE '====================================================';
  FOR r IN
    WITH live AS (
      SELECT 'live process-games' AS label,
        COUNT(*) AS n, COUNT(*) FILTER (WHERE hit IS NOT NULL) AS resolved,
        SUM(CASE WHEN hit THEN 1 ELSE 0 END) AS hits,
        ROUND(100.0 * SUM(CASE WHEN hit THEN 1 ELSE 0 END)
              / NULLIF(SUM(CASE WHEN hit IS NOT NULL THEN 1 ELSE 0 END), 0), 2) AS wr
      FROM pick_history
      WHERE source = 'process-games' AND is_synthetic = false
        AND game_date = '2026-04-25'::DATE
        AND prop_type NOT IN ('spread','game_total')
        AND confidence >= 70 AND confidence < 80
    ),
    old_syn AS (
      SELECT 'OLD synthetic (pre-fix)' AS label,
        COUNT(*), COUNT(*) FILTER (WHERE hit IS NOT NULL),
        SUM(CASE WHEN hit THEN 1 ELSE 0 END),
        ROUND(100.0 * SUM(CASE WHEN hit THEN 1 ELSE 0 END)
              / NULLIF(SUM(CASE WHEN hit IS NOT NULL THEN 1 ELSE 0 END), 0), 2)
      FROM pick_history
      WHERE source = 'backfill' AND is_synthetic = true
        AND backfill_run_id IS DISTINCT FROM new_run_id
        AND game_date = '2026-04-25'::DATE
        AND prop_type NOT IN ('spread','game_total')
        AND confidence >= 70 AND confidence < 80
    ),
    new_syn AS (
      SELECT 'NEW synthetic (post-fix)' AS label,
        COUNT(*), COUNT(*) FILTER (WHERE hit IS NOT NULL),
        SUM(CASE WHEN hit THEN 1 ELSE 0 END),
        ROUND(100.0 * SUM(CASE WHEN hit THEN 1 ELSE 0 END)
              / NULLIF(SUM(CASE WHEN hit IS NOT NULL THEN 1 ELSE 0 END), 0), 2)
      FROM pick_history
      WHERE backfill_run_id = new_run_id
        AND game_date = '2026-04-25'::DATE
        AND prop_type NOT IN ('spread','game_total')
        AND confidence >= 70 AND confidence < 80
    )
    SELECT * FROM live
    UNION ALL SELECT * FROM old_syn
    UNION ALL SELECT * FROM new_syn
  LOOP
    RAISE NOTICE '% n=% resolved=% hits=% wr=%',
      RPAD(r.label, 26), r.n, r.resolved, r.hits, r.wr;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== DONE ===';
END $$;

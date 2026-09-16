-- Tier 0 #12 — Phase 1: synthetic-vs-organic engine drift forensic.
-- READ-ONLY. No schema, scoring math, function, or production state changes.
--
-- Strategy:
--   1. Map calendar overlap between organic (process-games) and synthetic
--      (backfill / backfill-may7-9-organic) sources.
--   2. For overlapping dates, find natural-key matched pairs (same player,
--      prop_type, line, pick_side, game_date) and compute confidence + factor
--      score deltas between live engine and synthetic replay.
--   3. Sample-level inspection: show top-N pairs with largest drift.
--   4. Aggregate per-factor mean absolute delta to rank which factors drift
--      most across the matched-pair population.
--
-- Hypothesis space:
--   H1: same-pick confidence differs (algorithm code path divergence)
--   H2: same-pick factor scores differ (stale input snapshots)
--   H3: hit outcome differs (resolve-picks bug)
--   H4: no matched pairs (corpora don't overlap)
--   H5: synthetic doesn't cover post-megadeploy dates

DO $$
DECLARE
  r RECORD;
  matched_count INT;
BEGIN
  -- ========================================================
  -- TASK 1.1 — date overlap map
  -- ========================================================
  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== TASK 1.1 — date overlap, post-megadeploy ===';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '% | % | % | % | %',
    RPAD('game_date', 10),
    LPAD('process-games', 14), LPAD('backfill (syn)', 14),
    LPAD('backfill-may7-9', 15), LPAD('total', 6);
  FOR r IN
    SELECT
      game_date,
      COUNT(*) FILTER (WHERE source = 'process-games') AS organic_live,
      COUNT(*) FILTER (WHERE source = 'backfill' AND is_synthetic = true) AS synthetic_backfill,
      COUNT(*) FILTER (WHERE source = 'backfill-may7-9-organic') AS organic_replay,
      COUNT(*) AS total
    FROM pick_history
    WHERE game_date >= '2026-04-14'::DATE  -- when process-games started writing
      AND game_date <  '2026-05-12'::DATE
      AND prop_type NOT IN ('spread','game_total')
    GROUP BY game_date
    ORDER BY game_date
  LOOP
    RAISE NOTICE '% | % | % | % | %',
      RPAD(r.game_date::TEXT, 10),
      LPAD(r.organic_live::TEXT, 14),
      LPAD(r.synthetic_backfill::TEXT, 14),
      LPAD(r.organic_replay::TEXT, 15),
      LPAD(r.total::TEXT, 6);
  END LOOP;

  -- ========================================================
  -- TASK 1 / H5 — source-level date spans (refresh from D-123)
  -- ========================================================
  RAISE NOTICE '';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== Source date spans (player-prop only) ===';
  RAISE NOTICE '========================================================';
  FOR r IN
    SELECT
      source, is_synthetic,
      MIN(game_date) AS earliest, MAX(game_date) AS latest,
      COUNT(*) AS total
    FROM pick_history
    WHERE prop_type NOT IN ('spread','game_total')
      AND source IN ('process-games','backfill','backfill-may7-9-organic','dashboard')
    GROUP BY source, is_synthetic
    ORDER BY total DESC
  LOOP
    RAISE NOTICE 'source=% is_syn=% span=%..% n=%',
      RPAD(r.source, 24), r.is_synthetic,
      r.earliest, r.latest, r.total;
  END LOOP;

  -- ========================================================
  -- TASK 2 — Matched-pair join (natural key) — process-games × backfill (synthetic)
  --
  -- Match logic: same (player_name, prop_type, line, pick_side, game_date).
  -- Both rows must be resolved (hit IS NOT NULL) to compare outcomes.
  -- ========================================================
  CREATE TEMP TABLE IF NOT EXISTS matched_pairs AS
  WITH live AS (
    SELECT
      LOWER(player_name) AS norm_name,
      prop_type, line, pick_side, game_date,
      id            AS live_id,
      confidence    AS live_conf,
      hit           AS live_hit,
      actual_value  AS live_actual,
      odds          AS live_odds,
      season_hit_pct AS live_season_pct,
      score_l5, score_l10, score_season, score_recent_form,
      score_pace, score_opp_defense, score_player_injury,
      score_stale_data, score_market_conf, score_regression,
      score_z_score, score_floor_ceiling, score_minutes_floor,
      score_minutes_trend, score_consistency, score_role_change,
      score_usg_rate, score_b2b, score_rest, score_home_away_split,
      score_home_away, score_prop_type_penalty,
      score_minutes_volume, score_minutes_stability,
      score_vig_filter, score_trivial_line_penalty
    FROM pick_history
    WHERE source = 'process-games'
      AND is_synthetic = false
      AND prop_type NOT IN ('spread','game_total')
      AND game_date >= '2026-04-14'::DATE AND game_date < '20260512'
  ),
  syn AS (
    SELECT
      LOWER(player_name) AS norm_name,
      prop_type, line, pick_side, game_date,
      id            AS syn_id,
      confidence    AS syn_conf,
      hit           AS syn_hit,
      actual_value  AS syn_actual,
      odds          AS syn_odds,
      season_hit_pct AS syn_season_pct,
      score_l5     AS syn_score_l5,
      score_l10    AS syn_score_l10,
      score_season AS syn_score_season,
      score_recent_form AS syn_score_recent_form,
      score_pace AS syn_score_pace,
      score_opp_defense AS syn_score_opp_defense,
      score_player_injury AS syn_score_player_injury,
      score_stale_data AS syn_score_stale_data,
      score_market_conf AS syn_score_market_conf,
      score_regression AS syn_score_regression,
      score_z_score AS syn_score_z_score,
      score_floor_ceiling AS syn_score_floor_ceiling,
      score_minutes_floor AS syn_score_minutes_floor,
      score_minutes_trend AS syn_score_minutes_trend,
      score_consistency AS syn_score_consistency,
      score_role_change AS syn_score_role_change,
      score_usg_rate AS syn_score_usg_rate,
      score_b2b AS syn_score_b2b,
      score_rest AS syn_score_rest,
      score_home_away_split AS syn_score_home_away_split,
      score_home_away AS syn_score_home_away,
      score_prop_type_penalty AS syn_score_prop_type_penalty,
      score_minutes_volume AS syn_score_minutes_volume,
      score_minutes_stability AS syn_score_minutes_stability,
      score_vig_filter AS syn_score_vig_filter,
      score_trivial_line_penalty AS syn_score_trivial_line_penalty
    FROM pick_history
    WHERE source = 'backfill'
      AND is_synthetic = true
      AND prop_type NOT IN ('spread','game_total')
      AND game_date >= '2026-04-14'::DATE AND game_date < '20260512'
  )
  SELECT
    live.norm_name, live.prop_type, live.line, live.pick_side, live.game_date,
    live.live_id, live.live_conf, live.live_hit, live.live_actual,
    live.live_odds, live.live_season_pct,
    syn.syn_id, syn.syn_conf, syn.syn_hit, syn.syn_actual,
    syn.syn_odds, syn.syn_season_pct,
    -- factor deltas (live - synthetic)
    (COALESCE(live.score_l5, 0)            - COALESCE(syn.syn_score_l5, 0))            AS d_l5,
    (COALESCE(live.score_l10, 0)           - COALESCE(syn.syn_score_l10, 0))           AS d_l10,
    (COALESCE(live.score_season, 0)        - COALESCE(syn.syn_score_season, 0))        AS d_season,
    (COALESCE(live.score_recent_form, 0)   - COALESCE(syn.syn_score_recent_form, 0))   AS d_recent_form,
    (COALESCE(live.score_pace, 0)          - COALESCE(syn.syn_score_pace, 0))          AS d_pace,
    (COALESCE(live.score_opp_defense, 0)   - COALESCE(syn.syn_score_opp_defense, 0))   AS d_opp_defense,
    (COALESCE(live.score_player_injury, 0) - COALESCE(syn.syn_score_player_injury, 0)) AS d_player_injury,
    (COALESCE(live.score_stale_data, 0)    - COALESCE(syn.syn_score_stale_data, 0))    AS d_stale_data,
    (COALESCE(live.score_market_conf, 0)   - COALESCE(syn.syn_score_market_conf, 0))   AS d_market_conf,
    (COALESCE(live.score_regression, 0)    - COALESCE(syn.syn_score_regression, 0))    AS d_regression,
    (COALESCE(live.score_z_score, 0)       - COALESCE(syn.syn_score_z_score, 0))       AS d_z_score,
    (COALESCE(live.score_floor_ceiling, 0) - COALESCE(syn.syn_score_floor_ceiling, 0)) AS d_floor_ceiling,
    (COALESCE(live.score_minutes_floor, 0) - COALESCE(syn.syn_score_minutes_floor, 0)) AS d_minutes_floor,
    (COALESCE(live.score_minutes_trend, 0) - COALESCE(syn.syn_score_minutes_trend, 0)) AS d_minutes_trend,
    (COALESCE(live.score_consistency, 0)   - COALESCE(syn.syn_score_consistency, 0))   AS d_consistency,
    (COALESCE(live.score_role_change, 0)   - COALESCE(syn.syn_score_role_change, 0))   AS d_role_change,
    (COALESCE(live.score_usg_rate, 0)      - COALESCE(syn.syn_score_usg_rate, 0))      AS d_usg_rate,
    (COALESCE(live.score_b2b, 0)           - COALESCE(syn.syn_score_b2b, 0))           AS d_b2b,
    (COALESCE(live.score_rest, 0)          - COALESCE(syn.syn_score_rest, 0))          AS d_rest,
    (COALESCE(live.score_home_away_split, 0) - COALESCE(syn.syn_score_home_away_split, 0)) AS d_ha_split,
    (COALESCE(live.score_home_away, 0)     - COALESCE(syn.syn_score_home_away, 0))     AS d_home_away,
    (COALESCE(live.score_prop_type_penalty, 0) - COALESCE(syn.syn_score_prop_type_penalty, 0)) AS d_prop_type_pen,
    (COALESCE(live.score_minutes_volume, 0) - COALESCE(syn.syn_score_minutes_volume, 0)) AS d_mins_volume,
    (COALESCE(live.score_minutes_stability, 0) - COALESCE(syn.syn_score_minutes_stability, 0)) AS d_mins_stability,
    (COALESCE(live.score_vig_filter, 0)    - COALESCE(syn.syn_score_vig_filter, 0))    AS d_vig_filter,
    (COALESCE(live.score_trivial_line_penalty, 0) - COALESCE(syn.syn_score_trivial_line_penalty, 0)) AS d_trivial_pen
  FROM live
  JOIN syn USING (norm_name, prop_type, line, pick_side, game_date)
  ;

  SELECT COUNT(*) INTO matched_count FROM matched_pairs;
  RAISE NOTICE '';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== TASK 2 — matched-pair count (organic process-games × synthetic backfill) ===';
  RAISE NOTICE '========================================================';
  RAISE NOTICE 'Matched pairs (same player/prop/line/side/game_date): %', matched_count;

  IF matched_count = 0 THEN
    RAISE NOTICE '';
    RAISE NOTICE '⚠️  ZERO matched pairs — H4 dominates.';
    RAISE NOTICE 'Calendar window overlap exists but no exact-natural-key matches.';
    RAISE NOTICE 'Reasons could be:';
    RAISE NOTICE '  - process-games stores prop_type prefixed ("player_points"); backfill stores stripped ("points")';
    RAISE NOTICE '  - different line values per source (odds API line vs backfilled line)';
    RAISE NOTICE '  - different pick_sides selected (live picks over, synthetic picks under for same player)';
    RAISE NOTICE 'Phase 1 pivot needed. See TASK 6.';
  END IF;

  -- ========================================================
  -- TASK 3 H1 — confidence difference distribution
  -- ========================================================
  IF matched_count > 0 THEN
    RAISE NOTICE '';
    RAISE NOTICE '========================================================';
    RAISE NOTICE '=== TASK 3 H1 — confidence delta distribution (live - synthetic) ===';
    RAISE NOTICE '========================================================';
    FOR r IN
      SELECT
        ROUND(AVG(live_conf - syn_conf)::NUMERIC, 2) AS mean_delta,
        ROUND(STDDEV(live_conf - syn_conf)::NUMERIC, 2) AS std_delta,
        MIN(live_conf - syn_conf) AS min_delta,
        MAX(live_conf - syn_conf) AS max_delta,
        COUNT(*) FILTER (WHERE live_conf = syn_conf)            AS same_conf,
        COUNT(*) FILTER (WHERE ABS(live_conf - syn_conf) > 5)   AS gt5,
        COUNT(*) FILTER (WHERE ABS(live_conf - syn_conf) > 10)  AS gt10,
        COUNT(*) AS n
      FROM matched_pairs
    LOOP
      RAISE NOTICE 'mean=% std=% min=% max=% same_conf=% |Δ|>5: % |Δ|>10: % n=%',
        r.mean_delta, r.std_delta, r.min_delta, r.max_delta,
        r.same_conf, r.gt5, r.gt10, r.n;
    END LOOP;

    -- ========================================================
    -- TASK 3 H3 — hit outcome consistency
    -- ========================================================
    RAISE NOTICE '';
    RAISE NOTICE '========================================================';
    RAISE NOTICE '=== TASK 3 H3 — hit outcome consistency ===';
    RAISE NOTICE '========================================================';
    FOR r IN
      SELECT
        COUNT(*) FILTER (WHERE live_hit IS NOT NULL AND syn_hit IS NOT NULL) AS both_resolved,
        COUNT(*) FILTER (WHERE live_hit = syn_hit AND live_hit IS NOT NULL AND syn_hit IS NOT NULL) AS same_outcome,
        COUNT(*) FILTER (WHERE live_hit IS DISTINCT FROM syn_hit
                          AND live_hit IS NOT NULL AND syn_hit IS NOT NULL) AS diff_outcome,
        COUNT(*) FILTER (WHERE live_actual IS NOT NULL AND syn_actual IS NOT NULL
                          AND live_actual = syn_actual) AS same_actual,
        COUNT(*) FILTER (WHERE live_actual IS NOT NULL AND syn_actual IS NOT NULL
                          AND live_actual <> syn_actual) AS diff_actual
      FROM matched_pairs
    LOOP
      RAISE NOTICE 'both_resolved=% same_outcome=% diff_outcome=% same_actual_value=% diff_actual_value=%',
        r.both_resolved, r.same_outcome, r.diff_outcome, r.same_actual, r.diff_actual;
    END LOOP;

    -- ========================================================
    -- TASK 3 H2 — per-factor mean absolute delta (which factor drifts most)
    -- ========================================================
    RAISE NOTICE '';
    RAISE NOTICE '========================================================';
    RAISE NOTICE '=== TASK 3 H2 — per-factor mean abs delta (top drift) ===';
    RAISE NOTICE '========================================================';
    RAISE NOTICE '% | % | % | %',
      RPAD('factor', 22), LPAD('mean_abs', 9), LPAD('std', 7), LPAD('nonzero', 8);
    FOR r IN
      WITH factor_long AS (
        SELECT 'd_l5'            AS f, d_l5 AS v FROM matched_pairs UNION ALL
        SELECT 'd_l10',            d_l10 FROM matched_pairs UNION ALL
        SELECT 'd_season',         d_season FROM matched_pairs UNION ALL
        SELECT 'd_recent_form',    d_recent_form FROM matched_pairs UNION ALL
        SELECT 'd_pace',           d_pace FROM matched_pairs UNION ALL
        SELECT 'd_opp_defense',    d_opp_defense FROM matched_pairs UNION ALL
        SELECT 'd_player_injury',  d_player_injury FROM matched_pairs UNION ALL
        SELECT 'd_stale_data',     d_stale_data FROM matched_pairs UNION ALL
        SELECT 'd_market_conf',    d_market_conf FROM matched_pairs UNION ALL
        SELECT 'd_regression',     d_regression FROM matched_pairs UNION ALL
        SELECT 'd_z_score',        d_z_score FROM matched_pairs UNION ALL
        SELECT 'd_floor_ceiling',  d_floor_ceiling FROM matched_pairs UNION ALL
        SELECT 'd_minutes_floor',  d_minutes_floor FROM matched_pairs UNION ALL
        SELECT 'd_minutes_trend',  d_minutes_trend FROM matched_pairs UNION ALL
        SELECT 'd_consistency',    d_consistency FROM matched_pairs UNION ALL
        SELECT 'd_role_change',    d_role_change FROM matched_pairs UNION ALL
        SELECT 'd_usg_rate',       d_usg_rate FROM matched_pairs UNION ALL
        SELECT 'd_b2b',            d_b2b FROM matched_pairs UNION ALL
        SELECT 'd_rest',           d_rest FROM matched_pairs UNION ALL
        SELECT 'd_ha_split',       d_ha_split FROM matched_pairs UNION ALL
        SELECT 'd_home_away',      d_home_away FROM matched_pairs UNION ALL
        SELECT 'd_prop_type_pen',  d_prop_type_pen FROM matched_pairs UNION ALL
        SELECT 'd_mins_volume',    d_mins_volume FROM matched_pairs UNION ALL
        SELECT 'd_mins_stability', d_mins_stability FROM matched_pairs UNION ALL
        SELECT 'd_vig_filter',     d_vig_filter FROM matched_pairs UNION ALL
        SELECT 'd_trivial_pen',    d_trivial_pen FROM matched_pairs
      )
      SELECT
        f,
        ROUND(AVG(ABS(v))::NUMERIC, 3) AS mean_abs,
        ROUND(STDDEV(v)::NUMERIC, 3) AS std,
        COUNT(*) FILTER (WHERE v <> 0) AS nonzero
      FROM factor_long
      GROUP BY f
      ORDER BY mean_abs DESC
    LOOP
      RAISE NOTICE '% | % | % | %',
        RPAD(r.f, 22),
        LPAD(COALESCE(r.mean_abs::TEXT, '—'), 9),
        LPAD(COALESCE(r.std::TEXT, '—'), 7),
        LPAD(r.nonzero::TEXT, 8);
    END LOOP;

    -- ========================================================
    -- Sample: top 10 pairs by absolute confidence delta
    -- ========================================================
    RAISE NOTICE '';
    RAISE NOTICE '========================================================';
    RAISE NOTICE '=== Top 10 pairs by |confidence delta| ===';
    RAISE NOTICE '========================================================';
    FOR r IN
      SELECT
        norm_name, prop_type, line, pick_side, game_date,
        live_conf, syn_conf,
        (live_conf - syn_conf) AS delta,
        live_hit, syn_hit
      FROM matched_pairs
      ORDER BY ABS(live_conf - syn_conf) DESC
      LIMIT 10
    LOOP
      RAISE NOTICE 'date=% name=% prop=% side=% line=% live_conf=% syn_conf=% delta=% live_hit=% syn_hit=%',
        r.game_date,
        RPAD(LEFT(r.norm_name, 16), 16),
        RPAD(LEFT(r.prop_type, 10), 10),
        r.pick_side, r.line,
        r.live_conf, r.syn_conf, r.delta,
        r.live_hit, r.syn_hit;
    END LOOP;
  END IF;

  -- ========================================================
  -- Also check organic-replay vs organic-live (May 7-9)
  -- This is the 58.33% vs 50.00% comparison from D-123.
  -- ========================================================
  RAISE NOTICE '';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== Bonus — backfill-may7-9-organic × process-games matched pairs ===';
  RAISE NOTICE '   (both is_synthetic=false; different writers, same calendar)';
  RAISE NOTICE '========================================================';
  FOR r IN
    WITH live2 AS (
      SELECT LOWER(player_name) AS n, prop_type, line, pick_side, game_date,
             confidence AS c, hit
      FROM pick_history
      WHERE source = 'process-games' AND is_synthetic = false
        AND game_date >= '2026-05-07'::DATE AND game_date <= '2026-05-09'::DATE
        AND prop_type NOT IN ('spread','game_total')
    ),
    rep AS (
      SELECT LOWER(player_name) AS n, prop_type, line, pick_side, game_date,
             confidence AS c, hit
      FROM pick_history
      WHERE source = 'backfill-may7-9-organic'
        AND prop_type NOT IN ('spread','game_total')
    )
    SELECT
      COUNT(*) AS matched,
      ROUND(AVG(live2.c - rep.c)::NUMERIC, 2) AS mean_conf_delta,
      COUNT(*) FILTER (WHERE live2.hit IS DISTINCT FROM rep.hit
                        AND live2.hit IS NOT NULL AND rep.hit IS NOT NULL) AS hit_disagree
    FROM live2 JOIN rep USING (n, prop_type, line, pick_side, game_date)
  LOOP
    RAISE NOTICE 'matched=% mean_conf_delta=% hit_disagree=%',
      r.matched, r.mean_conf_delta, r.hit_disagree;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== DONE ===';
END $$;

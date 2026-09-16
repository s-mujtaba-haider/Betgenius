-- Tier 1 Fix #1 — Weight rebalance investigation (May 11, 2026).
--
-- READ-ONLY diagnostic. Does NOT modify algorithm_weights, scoring math,
-- backtest_weights_v3_synthetic_windowed, or any other function. Pure SELECT
-- queries against synthetic pick_history via the existing windowed backtest
-- function.
--
-- Per CEO §19.3 instructions: any algorithm_weights UPDATE is gated on CEO
-- approval after reviewing this output. This migration provides the inputs
-- for that decision; it does not act on them.
--
-- Three windows mirror optimize_weights_walk_forward defaults:
--   FULL     = 2026-02-01 to 2026-05-11  (all synthetic so far)
--   TRAIN    = 2026-02-01 to 2026-03-31  (training window)
--   VALIDATE = 2026-04-01 to 2026-05-03  (held-out window)
--
-- Four configs:
--   CURRENT  = whatever is in algorithm_weights id=1 right now
--   CONFIG_A = Conservative rebalance per CEO spec
--   CONFIG_B = Moderate rebalance per CEO spec
--   CONFIG_C = Aggressive rebalance per CEO spec

DO $$
DECLARE
  cw RECORD;
  r RECORD;
BEGIN
  -- Snapshot current weights.
  SELECT * INTO cw FROM algorithm_weights WHERE id = 1 LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'algorithm_weights id=1 not found — cannot run baseline';
  END IF;

  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== CURRENT WEIGHTS SNAPSHOT (id=1, updated_at=%) ===', cw.updated_at;
  RAISE NOTICE '========================================================';
  RAISE NOTICE 'w_l5            = %', cw.w_l5;
  RAISE NOTICE 'w_l10           = %', cw.w_l10;
  RAISE NOTICE 'w_season        = %', cw.w_season;
  RAISE NOTICE 'w_floor_ceiling = %', cw.w_floor_ceiling;
  RAISE NOTICE 'w_recent_form   = %', cw.w_recent_form;
  RAISE NOTICE 'w_home_away     = %', cw.w_home_away;
  RAISE NOTICE 'w_rest          = %', cw.w_rest;
  RAISE NOTICE 'w_b2b           = %', cw.w_b2b;
  RAISE NOTICE 'w_minutes_trend = %', cw.w_minutes_trend;
  RAISE NOTICE 'w_pace          = %', cw.w_pace;
  RAISE NOTICE 'w_opp_defense   = %', cw.w_opp_defense;
  RAISE NOTICE 'w_prop_type     = %', cw.w_prop_type;
  RAISE NOTICE 'w_z_score       = %', cw.w_z_score;
  RAISE NOTICE 'w_role_change   = %', cw.w_role_change;
  RAISE NOTICE 'w_vig_filter    = %', cw.w_vig_filter;
  RAISE NOTICE 'w_usg_rate      = %', cw.w_usg_rate;
  RAISE NOTICE 'w_regression    = %', cw.w_regression;
  RAISE NOTICE 'w_market_conf   = %', cw.w_market_conf;
  RAISE NOTICE 'w_ha_split      = %', cw.w_ha_split;
  RAISE NOTICE 'w_minutes_floor = %', cw.w_minutes_floor;
  RAISE NOTICE 'w_consistency   = %', cw.w_consistency;
  RAISE NOTICE 'w_stale_data    = %', cw.w_stale_data;
  RAISE NOTICE 'w_player_injury = %', cw.w_player_injury;

  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== HOT-STREAK vs REGRESSION TOTALS (CURRENT WEIGHTS) ===';
  RAISE NOTICE '========================================================';
  RAISE NOTICE 'Hot-streak total = w_l5 + w_l10 + w_recent_form + w_floor_ceiling = % + % + % + % = %',
    cw.w_l5, cw.w_l10, cw.w_recent_form, cw.w_floor_ceiling,
    cw.w_l5 + cw.w_l10 + cw.w_recent_form + cw.w_floor_ceiling;
  RAISE NOTICE 'Regression total = w_regression + w_z_score + w_season + w_market_conf = % + % + % + % = %',
    cw.w_regression, cw.w_z_score, cw.w_season, cw.w_market_conf,
    cw.w_regression + cw.w_z_score + cw.w_season + cw.w_market_conf;
  RAISE NOTICE 'Imbalance ratio (regression / hot-streak) = %',
    ROUND((cw.w_regression + cw.w_z_score + cw.w_season + cw.w_market_conf)::NUMERIC
        / NULLIF(cw.w_l5 + cw.w_l10 + cw.w_recent_form + cw.w_floor_ceiling, 0), 3);
  RAISE NOTICE 'Zero-weight factors (unused signal):';
  IF cw.w_l5 = 0 THEN RAISE NOTICE '  w_l5'; END IF;
  IF cw.w_l10 = 0 THEN RAISE NOTICE '  w_l10'; END IF;
  IF cw.w_season = 0 THEN RAISE NOTICE '  w_season'; END IF;
  IF cw.w_floor_ceiling = 0 THEN RAISE NOTICE '  w_floor_ceiling'; END IF;
  IF cw.w_recent_form = 0 THEN RAISE NOTICE '  w_recent_form'; END IF;
  IF cw.w_home_away = 0 THEN RAISE NOTICE '  w_home_away'; END IF;
  IF cw.w_rest = 0 THEN RAISE NOTICE '  w_rest'; END IF;
  IF cw.w_b2b = 0 THEN RAISE NOTICE '  w_b2b'; END IF;
  IF cw.w_minutes_trend = 0 THEN RAISE NOTICE '  w_minutes_trend'; END IF;
  IF cw.w_pace = 0 THEN RAISE NOTICE '  w_pace'; END IF;
  IF cw.w_opp_defense = 0 THEN RAISE NOTICE '  w_opp_defense'; END IF;
  IF cw.w_prop_type = 0 THEN RAISE NOTICE '  w_prop_type'; END IF;
  IF cw.w_z_score = 0 THEN RAISE NOTICE '  w_z_score'; END IF;
  IF cw.w_role_change = 0 THEN RAISE NOTICE '  w_role_change'; END IF;
  IF cw.w_vig_filter = 0 THEN RAISE NOTICE '  w_vig_filter'; END IF;
  IF cw.w_usg_rate = 0 THEN RAISE NOTICE '  w_usg_rate'; END IF;
  IF cw.w_regression = 0 THEN RAISE NOTICE '  w_regression'; END IF;
  IF cw.w_market_conf = 0 THEN RAISE NOTICE '  w_market_conf'; END IF;
  IF cw.w_ha_split = 0 THEN RAISE NOTICE '  w_ha_split'; END IF;
  IF cw.w_minutes_floor = 0 THEN RAISE NOTICE '  w_minutes_floor'; END IF;
  IF cw.w_consistency = 0 THEN RAISE NOTICE '  w_consistency'; END IF;
  IF cw.w_stale_data = 0 THEN RAISE NOTICE '  w_stale_data'; END IF;
  IF cw.w_player_injury = 0 THEN RAISE NOTICE '  w_player_injury'; END IF;

  -- Collect all backtest results into a TEMP TABLE for clean tabular output.
  CREATE TEMP TABLE IF NOT EXISTS rebalance_results (
    config       TEXT,
    win_label    TEXT,
    threshold    INTEGER,
    picks        BIGINT,
    hits         BIGINT,
    win_pct      NUMERIC,
    roi_pct      NUMERIC
  ) ON COMMIT DROP;

  -- ============================================================
  -- CURRENT × 3 windows
  -- ============================================================
  INSERT INTO rebalance_results SELECT 'CURRENT', 'FULL', t.* FROM backtest_weights_v3_synthetic_windowed(
    '2026-02-01'::DATE, '2026-05-11'::DATE,
    cw.w_l5, cw.w_l10, cw.w_season, cw.w_floor_ceiling, cw.w_recent_form, cw.w_home_away,
    cw.w_rest, cw.w_b2b, cw.w_minutes_trend, cw.w_pace, cw.w_opp_defense, cw.w_prop_type,
    cw.w_z_score, cw.w_role_change, cw.w_vig_filter, cw.w_usg_rate, cw.w_regression,
    cw.w_market_conf, cw.w_ha_split, cw.w_minutes_floor, cw.w_consistency,
    cw.w_stale_data, cw.w_player_injury, true
  ) t;
  INSERT INTO rebalance_results SELECT 'CURRENT', 'TRAIN', t.* FROM backtest_weights_v3_synthetic_windowed(
    '2026-02-01'::DATE, '2026-03-31'::DATE,
    cw.w_l5, cw.w_l10, cw.w_season, cw.w_floor_ceiling, cw.w_recent_form, cw.w_home_away,
    cw.w_rest, cw.w_b2b, cw.w_minutes_trend, cw.w_pace, cw.w_opp_defense, cw.w_prop_type,
    cw.w_z_score, cw.w_role_change, cw.w_vig_filter, cw.w_usg_rate, cw.w_regression,
    cw.w_market_conf, cw.w_ha_split, cw.w_minutes_floor, cw.w_consistency,
    cw.w_stale_data, cw.w_player_injury, true
  ) t;
  INSERT INTO rebalance_results SELECT 'CURRENT', 'VALIDATE', t.* FROM backtest_weights_v3_synthetic_windowed(
    '2026-04-01'::DATE, '2026-05-03'::DATE,
    cw.w_l5, cw.w_l10, cw.w_season, cw.w_floor_ceiling, cw.w_recent_form, cw.w_home_away,
    cw.w_rest, cw.w_b2b, cw.w_minutes_trend, cw.w_pace, cw.w_opp_defense, cw.w_prop_type,
    cw.w_z_score, cw.w_role_change, cw.w_vig_filter, cw.w_usg_rate, cw.w_regression,
    cw.w_market_conf, cw.w_ha_split, cw.w_minutes_floor, cw.w_consistency,
    cw.w_stale_data, cw.w_player_injury, true
  ) t;

  -- ============================================================
  -- CONFIG A — Conservative rebalance
  --   w_l5            1.0  → 0.5
  --   w_l10           0.0  → 0.0   (unchanged; already 0 in defaults)
  --   w_recent_form   1.5  → 1.0
  --   w_regression    1.0  → 1.5
  --   w_z_score       0.25 → 0.5
  --   w_season        1.75 → 2.0
  -- All other weights = current values for honest A/B comparison.
  -- ============================================================
  INSERT INTO rebalance_results SELECT 'CONFIG_A', 'FULL', t.* FROM backtest_weights_v3_synthetic_windowed(
    '2026-02-01'::DATE, '2026-05-11'::DATE,
    0.5,  cw.w_l10, 2.0,  cw.w_floor_ceiling, 1.0,  cw.w_home_away,
    cw.w_rest, cw.w_b2b, cw.w_minutes_trend, cw.w_pace, cw.w_opp_defense, cw.w_prop_type,
    0.5,  cw.w_role_change, cw.w_vig_filter, cw.w_usg_rate, 1.5,
    cw.w_market_conf, cw.w_ha_split, cw.w_minutes_floor, cw.w_consistency,
    cw.w_stale_data, cw.w_player_injury, true
  ) t;
  INSERT INTO rebalance_results SELECT 'CONFIG_A', 'TRAIN', t.* FROM backtest_weights_v3_synthetic_windowed(
    '2026-02-01'::DATE, '2026-03-31'::DATE,
    0.5,  cw.w_l10, 2.0,  cw.w_floor_ceiling, 1.0,  cw.w_home_away,
    cw.w_rest, cw.w_b2b, cw.w_minutes_trend, cw.w_pace, cw.w_opp_defense, cw.w_prop_type,
    0.5,  cw.w_role_change, cw.w_vig_filter, cw.w_usg_rate, 1.5,
    cw.w_market_conf, cw.w_ha_split, cw.w_minutes_floor, cw.w_consistency,
    cw.w_stale_data, cw.w_player_injury, true
  ) t;
  INSERT INTO rebalance_results SELECT 'CONFIG_A', 'VALIDATE', t.* FROM backtest_weights_v3_synthetic_windowed(
    '2026-04-01'::DATE, '2026-05-03'::DATE,
    0.5,  cw.w_l10, 2.0,  cw.w_floor_ceiling, 1.0,  cw.w_home_away,
    cw.w_rest, cw.w_b2b, cw.w_minutes_trend, cw.w_pace, cw.w_opp_defense, cw.w_prop_type,
    0.5,  cw.w_role_change, cw.w_vig_filter, cw.w_usg_rate, 1.5,
    cw.w_market_conf, cw.w_ha_split, cw.w_minutes_floor, cw.w_consistency,
    cw.w_stale_data, cw.w_player_injury, true
  ) t;

  -- ============================================================
  -- CONFIG B — Moderate rebalance
  --   w_l5            1.0  → 0.25
  --   w_recent_form   1.5  → 0.75
  --   w_regression    1.0  → 2.0
  --   w_z_score       0.25 → 0.75
  --   w_season        1.75 → 2.5
  --   w_market_conf   2.0  → 2.25
  -- ============================================================
  INSERT INTO rebalance_results SELECT 'CONFIG_B', 'FULL', t.* FROM backtest_weights_v3_synthetic_windowed(
    '2026-02-01'::DATE, '2026-05-11'::DATE,
    0.25, cw.w_l10, 2.5,  cw.w_floor_ceiling, 0.75, cw.w_home_away,
    cw.w_rest, cw.w_b2b, cw.w_minutes_trend, cw.w_pace, cw.w_opp_defense, cw.w_prop_type,
    0.75, cw.w_role_change, cw.w_vig_filter, cw.w_usg_rate, 2.0,
    2.25, cw.w_ha_split, cw.w_minutes_floor, cw.w_consistency,
    cw.w_stale_data, cw.w_player_injury, true
  ) t;
  INSERT INTO rebalance_results SELECT 'CONFIG_B', 'TRAIN', t.* FROM backtest_weights_v3_synthetic_windowed(
    '2026-02-01'::DATE, '2026-03-31'::DATE,
    0.25, cw.w_l10, 2.5,  cw.w_floor_ceiling, 0.75, cw.w_home_away,
    cw.w_rest, cw.w_b2b, cw.w_minutes_trend, cw.w_pace, cw.w_opp_defense, cw.w_prop_type,
    0.75, cw.w_role_change, cw.w_vig_filter, cw.w_usg_rate, 2.0,
    2.25, cw.w_ha_split, cw.w_minutes_floor, cw.w_consistency,
    cw.w_stale_data, cw.w_player_injury, true
  ) t;
  INSERT INTO rebalance_results SELECT 'CONFIG_B', 'VALIDATE', t.* FROM backtest_weights_v3_synthetic_windowed(
    '2026-04-01'::DATE, '2026-05-03'::DATE,
    0.25, cw.w_l10, 2.5,  cw.w_floor_ceiling, 0.75, cw.w_home_away,
    cw.w_rest, cw.w_b2b, cw.w_minutes_trend, cw.w_pace, cw.w_opp_defense, cw.w_prop_type,
    0.75, cw.w_role_change, cw.w_vig_filter, cw.w_usg_rate, 2.0,
    2.25, cw.w_ha_split, cw.w_minutes_floor, cw.w_consistency,
    cw.w_stale_data, cw.w_player_injury, true
  ) t;

  -- ============================================================
  -- CONFIG C — Aggressive rebalance
  --   w_l5            1.0  → 0.0
  --   w_recent_form   1.5  → 0.5
  --   w_floor_ceiling 1.5  → 1.0
  --   w_regression    1.0  → 2.5
  --   w_z_score       0.25 → 1.0
  --   w_season        1.75 → 3.0
  --   w_market_conf   2.0  → 3.0
  -- ============================================================
  INSERT INTO rebalance_results SELECT 'CONFIG_C', 'FULL', t.* FROM backtest_weights_v3_synthetic_windowed(
    '2026-02-01'::DATE, '2026-05-11'::DATE,
    0.0,  cw.w_l10, 3.0,  1.0,                0.5,  cw.w_home_away,
    cw.w_rest, cw.w_b2b, cw.w_minutes_trend, cw.w_pace, cw.w_opp_defense, cw.w_prop_type,
    1.0,  cw.w_role_change, cw.w_vig_filter, cw.w_usg_rate, 2.5,
    3.0,  cw.w_ha_split, cw.w_minutes_floor, cw.w_consistency,
    cw.w_stale_data, cw.w_player_injury, true
  ) t;
  INSERT INTO rebalance_results SELECT 'CONFIG_C', 'TRAIN', t.* FROM backtest_weights_v3_synthetic_windowed(
    '2026-02-01'::DATE, '2026-03-31'::DATE,
    0.0,  cw.w_l10, 3.0,  1.0,                0.5,  cw.w_home_away,
    cw.w_rest, cw.w_b2b, cw.w_minutes_trend, cw.w_pace, cw.w_opp_defense, cw.w_prop_type,
    1.0,  cw.w_role_change, cw.w_vig_filter, cw.w_usg_rate, 2.5,
    3.0,  cw.w_ha_split, cw.w_minutes_floor, cw.w_consistency,
    cw.w_stale_data, cw.w_player_injury, true
  ) t;
  INSERT INTO rebalance_results SELECT 'CONFIG_C', 'VALIDATE', t.* FROM backtest_weights_v3_synthetic_windowed(
    '2026-04-01'::DATE, '2026-05-03'::DATE,
    0.0,  cw.w_l10, 3.0,  1.0,                0.5,  cw.w_home_away,
    cw.w_rest, cw.w_b2b, cw.w_minutes_trend, cw.w_pace, cw.w_opp_defense, cw.w_prop_type,
    1.0,  cw.w_role_change, cw.w_vig_filter, cw.w_usg_rate, 2.5,
    3.0,  cw.w_ha_split, cw.w_minutes_floor, cw.w_consistency,
    cw.w_stale_data, cw.w_player_injury, true
  ) t;

  -- ============================================================
  -- Dump raw cumulative results (threshold = at-or-above).
  -- ============================================================
  RAISE NOTICE '';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== RAW CUMULATIVE RESULTS (picks at-or-above threshold) ===';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '% | % | % | % | % | % | %',
    RPAD('config', 9), RPAD('window', 9), RPAD('thresh', 6),
    LPAD('picks', 6), LPAD('hits', 6), LPAD('win_pct', 8), LPAD('roi_pct', 8);
  FOR r IN
    SELECT config, win_label, threshold, picks, hits, win_pct, roi_pct
    FROM rebalance_results
    ORDER BY config, win_label, threshold
  LOOP
    RAISE NOTICE '% | % | % | % | % | % | %',
      RPAD(r.config, 9), RPAD(r.win_label, 9), LPAD(r.threshold::TEXT, 6),
      LPAD(r.picks::TEXT, 6), LPAD(r.hits::TEXT, 6),
      LPAD(COALESCE(r.win_pct::TEXT, '—'), 8),
      LPAD(COALESCE(r.roi_pct::TEXT, '—'), 8);
  END LOOP;

  -- ============================================================
  -- Per-tier breakdown (compute from cumulative diffs)
  -- 60-69 = thresh=60 minus thresh=70
  -- 70-79 = thresh=70 minus thresh=80   ← LAUNCH-DEFINING TIER
  -- 80-89 = thresh=80 minus thresh=90
  -- 90+   = thresh=90
  -- ============================================================
  RAISE NOTICE '';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== PER-TIER BREAKDOWN (mutually exclusive bands) ===';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '% | % | % | % | % | %',
    RPAD('config', 9), RPAD('window', 9), RPAD('tier', 8),
    LPAD('picks', 6), LPAD('hits', 6), LPAD('win_pct', 8);
  FOR r IN
    WITH pivot AS (
      SELECT config, win_label,
        MAX(CASE WHEN threshold = 60 THEN picks END) AS p60,
        MAX(CASE WHEN threshold = 60 THEN hits  END) AS h60,
        MAX(CASE WHEN threshold = 70 THEN picks END) AS p70,
        MAX(CASE WHEN threshold = 70 THEN hits  END) AS h70,
        MAX(CASE WHEN threshold = 80 THEN picks END) AS p80,
        MAX(CASE WHEN threshold = 80 THEN hits  END) AS h80,
        MAX(CASE WHEN threshold = 90 THEN picks END) AS p90,
        MAX(CASE WHEN threshold = 90 THEN hits  END) AS h90
      FROM rebalance_results
      GROUP BY config, win_label
    )
    SELECT config, win_label, '60-69' AS tier,
           COALESCE(p60, 0) - COALESCE(p70, 0) AS picks,
           COALESCE(h60, 0) - COALESCE(h70, 0) AS hits,
           CASE WHEN COALESCE(p60, 0) - COALESCE(p70, 0) > 0
                THEN ROUND(100.0 * (COALESCE(h60, 0) - COALESCE(h70, 0))
                         / (COALESCE(p60, 0) - COALESCE(p70, 0)), 2) END AS win_pct
    FROM pivot
    UNION ALL
    SELECT config, win_label, '70-79' AS tier,
           COALESCE(p70, 0) - COALESCE(p80, 0),
           COALESCE(h70, 0) - COALESCE(h80, 0),
           CASE WHEN COALESCE(p70, 0) - COALESCE(p80, 0) > 0
                THEN ROUND(100.0 * (COALESCE(h70, 0) - COALESCE(h80, 0))
                         / (COALESCE(p70, 0) - COALESCE(p80, 0)), 2) END
    FROM pivot
    UNION ALL
    SELECT config, win_label, '80-89' AS tier,
           COALESCE(p80, 0) - COALESCE(p90, 0),
           COALESCE(h80, 0) - COALESCE(h90, 0),
           CASE WHEN COALESCE(p80, 0) - COALESCE(p90, 0) > 0
                THEN ROUND(100.0 * (COALESCE(h80, 0) - COALESCE(h90, 0))
                         / (COALESCE(p80, 0) - COALESCE(p90, 0)), 2) END
    FROM pivot
    UNION ALL
    SELECT config, win_label, '90+'  AS tier,
           COALESCE(p90, 0),
           COALESCE(h90, 0),
           CASE WHEN COALESCE(p90, 0) > 0
                THEN ROUND(100.0 * COALESCE(h90, 0) / COALESCE(p90, 0), 2) END
    FROM pivot
    ORDER BY config, win_label, tier
  LOOP
    RAISE NOTICE '% | % | % | % | % | %',
      RPAD(r.config, 9), RPAD(r.win_label, 9), RPAD(r.tier, 8),
      LPAD(r.picks::TEXT, 6), LPAD(r.hits::TEXT, 6),
      LPAD(COALESCE(r.win_pct::TEXT, '—'), 8);
  END LOOP;

  -- ============================================================
  -- Walk-forward style delta_validate (proposed vs CURRENT on validate
  -- window) at threshold 70. Decision class per the same thresholds
  -- optimize_weights_walk_forward uses (approve > +0.5pp, reject < -0.5pp).
  -- This treats CURRENT-on-VALIDATE as the baseline that any rebalance
  -- needs to beat on the held-out window.
  -- ============================================================
  RAISE NOTICE '';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== WALK-FORWARD DECISIONS (vs CURRENT on VALIDATE, thresh=70) ===';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '% | % | % | % | % | %',
    RPAD('config', 9), LPAD('valid_wr', 9), LPAD('cur_wr', 8),
    LPAD('delta', 7), LPAD('train_wr', 9), RPAD('decision', 25);
  FOR r IN
    WITH p AS (
      SELECT config, win_label,
        MAX(CASE WHEN threshold = 70 THEN win_pct END) AS wr70
      FROM rebalance_results
      GROUP BY config, win_label
    ),
    pivoted AS (
      SELECT
        config,
        MAX(CASE WHEN win_label = 'TRAIN'    THEN wr70 END) AS train_wr,
        MAX(CASE WHEN win_label = 'VALIDATE' THEN wr70 END) AS valid_wr
      FROM p
      GROUP BY config
    ),
    cur_baseline AS (
      SELECT valid_wr AS cur_valid_wr FROM pivoted WHERE config = 'CURRENT'
    )
    SELECT
      pv.config,
      pv.valid_wr,
      cb.cur_valid_wr,
      pv.valid_wr - cb.cur_valid_wr AS delta_validate_pp,
      pv.train_wr,
      CASE
        WHEN pv.config = 'CURRENT' THEN '(baseline)'
        WHEN pv.valid_wr IS NULL OR cb.cur_valid_wr IS NULL THEN 'INSUFFICIENT_VALIDATE_DATA'
        WHEN pv.valid_wr - cb.cur_valid_wr >  0.5 THEN 'APPROVE'
        WHEN pv.valid_wr - cb.cur_valid_wr < -0.5 THEN 'REJECT_OVERFIT'
        ELSE 'NO_SIGNAL'
      END AS decision
    FROM pivoted pv CROSS JOIN cur_baseline cb
    WHERE pv.config <> 'CURRENT' OR true
    ORDER BY pv.config
  LOOP
    RAISE NOTICE '% | % | % | % | % | %',
      RPAD(r.config, 9),
      LPAD(COALESCE(r.valid_wr::TEXT, '—'), 9),
      LPAD(COALESCE(r.cur_valid_wr::TEXT, '—'), 8),
      LPAD(COALESCE(ROUND(r.delta_validate_pp, 2)::TEXT, '—'), 7),
      LPAD(COALESCE(r.train_wr::TEXT, '—'), 9),
      RPAD(r.decision, 25);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== DONE — see RAISE NOTICE output above for results ===';
  RAISE NOTICE '========================================================';
END $$;

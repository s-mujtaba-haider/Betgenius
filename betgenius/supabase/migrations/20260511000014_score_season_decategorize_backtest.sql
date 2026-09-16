-- Tier 1 Fix #4 — score_season de-categorize: design + counterfactual backtest.
-- READ-ONLY. No UPDATE on algorithm_weights / pick_history / scoring math /
-- backtest_weights_v3 function. Pure SELECT with inline counterfactual CTE.
--
-- Per CEO §19.3 instructions: any scoring math change is gated on CEO
-- approval after reviewing this output. This migration provides the inputs
-- for that decision; it does not act on them.
--
-- The counterfactual: re-uses the EXACT scoring math from
-- backtest_weights_v3_synthetic_windowed (migration 20260507000004) but
-- swaps the score_season column for an inline-computed value from one of
-- four candidate formulas. All other 22 weights × scores unchanged.
--
-- Current formula (process-games:1123):
--   score_season = CASE WHEN season_hit_pct >= 70 THEN 10
--                       WHEN season_hit_pct >= 50 THEN 3
--                       WHEN season_hit_pct >= 40 THEN 0
--                       ELSE -8 END
-- (4 buckets, not 3 as the CEO spec assumed; -8 floor for low hit-rate.)
--
-- Options:
--   OPTION_A — Linear continuous: clamp((season_hit_pct - 50) * 0.20, -5, +10)
--   OPTION_B — 5-bucket discrete: -3 / 0 / +2 / +5 / +8 / +10
--   OPTION_C — Linear asymmetric: clamp((season_hit_pct - 55) * 0.24, -8, +10)
--   OPTION_D — Sample-size-aware. DEFERRED: requires season_games_played
--              column which isn't in pick_history schema today.
--
-- Three windows mirror Tier 1 #1 investigation precedent:
--   FULL_SYN     = 2026-02-01 .. 2026-05-11, is_synthetic=true
--   TRAIN_SYN    = 2026-02-01 .. 2026-03-31, is_synthetic=true (walk-forward)
--   VALIDATE_SYN = 2026-04-01 .. 2026-05-03, is_synthetic=true (walk-forward)
--   ORGANIC_LIVE = 2026-05-04 .. 2026-05-11, is_synthetic=false, source=process-games
--                  (small n; honest reference per framework v2.33 §15.7.8 #4)

DO $$
DECLARE
  cw RECORD;
  r RECORD;
BEGIN
  -- ========================================================
  -- TASK 1.2 — Current score_season distribution (post-May-4 organic)
  -- ========================================================
  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== TASK 1.2 — current score_season distribution ===';
  RAISE NOTICE '   (post-May-4 organic, source=process-games)';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '% | % | %', RPAD('bucket', 7), LPAD('n', 6), RPAD('description', 30);
  FOR r IN
    SELECT score_season, COUNT(*) AS n
    FROM pick_history
    WHERE created_at >= '2026-05-04'::timestamptz
      AND source = 'process-games'
      AND prop_type NOT IN ('spread','game_total')
    GROUP BY score_season
    ORDER BY score_season
  LOOP
    RAISE NOTICE '% | % | %',
      LPAD(COALESCE(r.score_season::TEXT, '(null)'), 7),
      LPAD(r.n::TEXT, 6),
      RPAD(CASE r.score_season
        WHEN -8 THEN 'season_hit_pct < 40'
        WHEN 0  THEN '40 <= season_hit_pct < 50'
        WHEN 3  THEN '50 <= season_hit_pct < 70'
        WHEN 10 THEN '70 <= season_hit_pct'
        ELSE '(unexpected bucket)' END, 30);
  END LOOP;

  -- ========================================================
  -- TASK 1.3 — hit/miss split by current score_season bucket
  -- ========================================================
  RAISE NOTICE '';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== TASK 1.3 — score_season × hit (post-May-4 organic) ===';
  RAISE NOTICE '   prop_type IN (points, rebounds, assists)';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '% | % | % | % | %',
    LPAD('bucket', 6), RPAD('hit?', 5), LPAD('n', 5),
    LPAD('avg_seas%', 9), LPAD('avg_line', 9);
  FOR r IN
    SELECT score_season, hit, COUNT(*) AS n,
      ROUND(AVG(season_hit_pct)::NUMERIC, 2) AS avg_seas_pct,
      ROUND(AVG(line)::NUMERIC, 2) AS avg_line
    FROM pick_history
    WHERE created_at >= '2026-05-04'::timestamptz
      AND source = 'process-games'
      AND hit IS NOT NULL
      AND prop_type IN ('points','rebounds','assists')
    GROUP BY score_season, hit
    ORDER BY score_season, hit DESC
  LOOP
    RAISE NOTICE '% | % | % | % | %',
      LPAD(COALESCE(r.score_season::TEXT, '(null)'), 6),
      RPAD(r.hit::TEXT, 5),
      LPAD(r.n::TEXT, 5),
      LPAD(COALESCE(r.avg_seas_pct::TEXT, '—'), 9),
      LPAD(COALESCE(r.avg_line::TEXT, '—'), 9);
  END LOOP;

  -- ========================================================
  -- Snapshot current weights (need them for the reconstruction)
  -- ========================================================
  SELECT * INTO cw FROM algorithm_weights WHERE id = 1 LIMIT 1;
  RAISE NOTICE '';
  RAISE NOTICE 'Reconstructing with current weights: w_season=%, w_l5=%, w_l10=%, ...',
    cw.w_season, cw.w_l5, cw.w_l10;

  -- ========================================================
  -- TASK 3 — Counterfactual backtest, 4 options × 4 windows
  -- ========================================================
  CREATE TEMP TABLE IF NOT EXISTS season_options (
    win_label TEXT, option_name TEXT, threshold INT,
    picks BIGINT, hits BIGINT, win_pct NUMERIC, roi_pct NUMERIC
  ) ON COMMIT DROP;

  -- Helper inline: for each (window × option) combo, run a CTE that
  -- mirrors backtest_weights_v3_synthetic_windowed math but uses an
  -- option-specific score_season recomputed from season_hit_pct.
  --
  -- Macro expansion: 4 options × 4 windows = 16 backtests. We'll structure
  -- as one CTE pipeline per window, parameterized by a CROSS JOIN over
  -- option-formula values.

  FOR r IN
    WITH rows AS (
      SELECT
        'FULL_SYN'::TEXT AS win_label,
        hit, odds, season_hit_pct, score_trivial_line_cap,
        score_l5, score_l10, score_floor_ceiling, score_recent_form,
        score_home_away, score_rest, score_b2b, score_minutes_trend,
        score_pace, score_opp_defense, score_prop_type_penalty,
        score_z_score, score_role_change, score_vig_filter, score_usg_rate,
        score_regression, score_market_conf, score_home_away_split,
        score_minutes_volume, score_minutes_stability, score_consistency,
        score_stale_data, score_player_injury, score_trivial_line_penalty
      FROM pick_history
      WHERE is_synthetic = true
        AND hit IS NOT NULL
        AND prop_type NOT IN ('spread','game_total')
        AND created_at >= '2026-02-01'::timestamptz
        AND created_at <  '2026-05-12'::timestamptz
      UNION ALL
      SELECT
        'TRAIN_SYN'::TEXT,
        hit, odds, season_hit_pct, score_trivial_line_cap,
        score_l5, score_l10, score_floor_ceiling, score_recent_form,
        score_home_away, score_rest, score_b2b, score_minutes_trend,
        score_pace, score_opp_defense, score_prop_type_penalty,
        score_z_score, score_role_change, score_vig_filter, score_usg_rate,
        score_regression, score_market_conf, score_home_away_split,
        score_minutes_volume, score_minutes_stability, score_consistency,
        score_stale_data, score_player_injury, score_trivial_line_penalty
      FROM pick_history
      WHERE is_synthetic = true
        AND hit IS NOT NULL
        AND prop_type NOT IN ('spread','game_total')
        AND created_at >= '2026-02-01'::timestamptz
        AND created_at <  '2026-04-01'::timestamptz
      UNION ALL
      SELECT
        'VALIDATE_SYN'::TEXT,
        hit, odds, season_hit_pct, score_trivial_line_cap,
        score_l5, score_l10, score_floor_ceiling, score_recent_form,
        score_home_away, score_rest, score_b2b, score_minutes_trend,
        score_pace, score_opp_defense, score_prop_type_penalty,
        score_z_score, score_role_change, score_vig_filter, score_usg_rate,
        score_regression, score_market_conf, score_home_away_split,
        score_minutes_volume, score_minutes_stability, score_consistency,
        score_stale_data, score_player_injury, score_trivial_line_penalty
      FROM pick_history
      WHERE is_synthetic = true
        AND hit IS NOT NULL
        AND prop_type NOT IN ('spread','game_total')
        AND created_at >= '2026-04-01'::timestamptz
        AND created_at <  '2026-05-04'::timestamptz
      UNION ALL
      SELECT
        'ORGANIC_LIVE'::TEXT,
        hit, odds, season_hit_pct, score_trivial_line_cap,
        score_l5, score_l10, score_floor_ceiling, score_recent_form,
        score_home_away, score_rest, score_b2b, score_minutes_trend,
        score_pace, score_opp_defense, score_prop_type_penalty,
        score_z_score, score_role_change, score_vig_filter, score_usg_rate,
        score_regression, score_market_conf, score_home_away_split,
        score_minutes_volume, score_minutes_stability, score_consistency,
        score_stale_data, score_player_injury, score_trivial_line_penalty
      FROM pick_history
      WHERE is_synthetic = false
        AND source = 'process-games'
        AND hit IS NOT NULL
        AND prop_type NOT IN ('spread','game_total')
        AND created_at >= '2026-05-04'::timestamptz
        AND created_at <  '2026-05-12'::timestamptz
    ),
    options AS (
      SELECT
        rows.*,
        opt.option_name,
        opt.recomputed_score_season
      FROM rows
      CROSS JOIN LATERAL (
        VALUES
          ('CURRENT'::TEXT,
            (CASE
              WHEN rows.season_hit_pct >= 70 THEN 10
              WHEN rows.season_hit_pct >= 50 THEN 3
              WHEN rows.season_hit_pct >= 40 THEN 0
              ELSE -8
            END)::NUMERIC),
          ('OPTION_A'::TEXT,
            GREATEST(-5::NUMERIC,
              LEAST(10::NUMERIC,
                (COALESCE(rows.season_hit_pct, 0) - 50) * 0.20))),
          ('OPTION_B'::TEXT,
            (CASE
              WHEN rows.season_hit_pct >= 80 THEN 10
              WHEN rows.season_hit_pct >= 70 THEN 8
              WHEN rows.season_hit_pct >= 60 THEN 5
              WHEN rows.season_hit_pct >= 50 THEN 2
              WHEN rows.season_hit_pct >= 40 THEN 0
              ELSE -3
            END)::NUMERIC),
          ('OPTION_C'::TEXT,
            GREATEST(-8::NUMERIC,
              LEAST(10::NUMERIC,
                (COALESCE(rows.season_hit_pct, 0) - 55) * 0.24)))
      ) AS opt(option_name, recomputed_score_season)
    ),
    scored AS (
      SELECT
        win_label, option_name, hit, odds, score_trivial_line_cap,
        GREATEST(0, LEAST(100,
          50
          + ROUND(COALESCE(score_l5, 0)::NUMERIC * cw.w_l5)
          + ROUND(COALESCE(score_l10, 0)::NUMERIC * cw.w_l10)
          + ROUND(recomputed_score_season * cw.w_season)            -- swapped
          + ROUND(COALESCE(score_floor_ceiling, 0)::NUMERIC * cw.w_floor_ceiling)
          + ROUND(COALESCE(score_recent_form, 0)::NUMERIC * cw.w_recent_form)
          + ROUND(COALESCE(score_home_away, 0)::NUMERIC * cw.w_home_away)
          + ROUND(COALESCE(score_rest, 0)::NUMERIC * cw.w_rest)
          + ROUND(COALESCE(score_b2b, 0)::NUMERIC * cw.w_b2b)
          + ROUND(COALESCE(score_minutes_trend, 0)::NUMERIC * cw.w_minutes_trend)
          + ROUND(COALESCE(score_pace, 0)::NUMERIC * cw.w_pace)
          + ROUND(COALESCE(score_opp_defense, 0)::NUMERIC * cw.w_opp_defense)
          + ROUND(COALESCE(score_prop_type_penalty, 0)::NUMERIC * cw.w_prop_type)
          + ROUND(COALESCE(score_z_score, 0)::NUMERIC * cw.w_z_score)
          + ROUND(COALESCE(score_role_change, 0)::NUMERIC * cw.w_role_change)
          + ROUND(COALESCE(score_vig_filter, 0)::NUMERIC * cw.w_vig_filter)
          + ROUND(COALESCE(score_usg_rate, 0)::NUMERIC * cw.w_usg_rate)
          + ROUND(COALESCE(score_regression, 0)::NUMERIC * cw.w_regression)
          + ROUND(COALESCE(score_market_conf, 0)::NUMERIC * cw.w_market_conf)
          + ROUND(COALESCE(score_home_away_split, 0)::NUMERIC * cw.w_ha_split)
          + ROUND(COALESCE(score_minutes_volume, 0)::NUMERIC * cw.w_minutes_floor)
          + ROUND(COALESCE(score_minutes_stability, 0)::NUMERIC * cw.w_minutes_floor)
          + ROUND(COALESCE(score_consistency, 0)::NUMERIC * cw.w_consistency)
          + ROUND(COALESCE(score_stale_data, 0)::NUMERIC * cw.w_stale_data)
          + ROUND(COALESCE(score_player_injury, 0)::NUMERIC * cw.w_player_injury)
          + COALESCE(score_trivial_line_penalty, 0)::NUMERIC
        )) AS raw_reconstructed
      FROM options
    ),
    capped AS (
      SELECT win_label, option_name, hit, odds,
        CASE
          WHEN COALESCE(score_trivial_line_cap, false) AND raw_reconstructed > 65 THEN 65
          ELSE raw_reconstructed
        END AS conf
      FROM scored
    ),
    final AS (
      SELECT
        win_label, option_name, t.threshold,
        COUNT(*)::BIGINT AS picks,
        SUM(CASE WHEN hit THEN 1 ELSE 0 END)::BIGINT AS hits,
        ROUND(100.0 * SUM(CASE WHEN hit THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 2) AS win_pct,
        ROUND(100.0 * SUM(
          CASE WHEN hit THEN
            CASE WHEN odds > 0 THEN odds::NUMERIC ELSE 10000.0 / ABS(odds::NUMERIC) END
          ELSE -100 END
        ) / NULLIF(COUNT(*), 0) / 100, 2) AS roi_pct
      FROM capped
      CROSS JOIN (VALUES (60), (70), (80), (90)) AS t(threshold)
      WHERE conf >= t.threshold
      GROUP BY win_label, option_name, t.threshold
    )
    SELECT * FROM final
    ORDER BY win_label, option_name, threshold
  LOOP
    INSERT INTO season_options (win_label, option_name, threshold, picks, hits, win_pct, roi_pct)
    VALUES (r.win_label, r.option_name, r.threshold, r.picks, r.hits, r.win_pct, r.roi_pct);
  END LOOP;

  -- ========================================================
  -- Dump cumulative-threshold results
  -- ========================================================
  RAISE NOTICE '';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== CUMULATIVE RESULTS (at-or-above threshold) ===';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '% | % | % | % | % | % | %',
    RPAD('window', 13), RPAD('option', 9), LPAD('thresh', 6),
    LPAD('picks', 6), LPAD('hits', 6), LPAD('wr%', 7), LPAD('roi%', 7);
  FOR r IN
    SELECT win_label, option_name, threshold, picks, hits, win_pct, roi_pct
    FROM season_options
    ORDER BY win_label, option_name, threshold
  LOOP
    RAISE NOTICE '% | % | % | % | % | % | %',
      RPAD(r.win_label, 13), RPAD(r.option_name, 9),
      LPAD(r.threshold::TEXT, 6), LPAD(r.picks::TEXT, 6),
      LPAD(r.hits::TEXT, 6),
      LPAD(COALESCE(r.win_pct::TEXT, '—'), 7),
      LPAD(COALESCE(r.roi_pct::TEXT, '—'), 7);
  END LOOP;

  -- ========================================================
  -- Per-tier breakdown via cumulative subtraction
  -- ========================================================
  RAISE NOTICE '';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== PER-TIER BREAKDOWN (mutually exclusive bands) ===';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '% | % | % | % | % | %',
    RPAD('window', 13), RPAD('option', 9), RPAD('tier', 7),
    LPAD('picks', 6), LPAD('hits', 6), LPAD('wr%', 7);
  FOR r IN
    WITH p AS (
      SELECT win_label, option_name,
        MAX(CASE WHEN threshold = 60 THEN picks END) AS p60,
        MAX(CASE WHEN threshold = 60 THEN hits  END) AS h60,
        MAX(CASE WHEN threshold = 70 THEN picks END) AS p70,
        MAX(CASE WHEN threshold = 70 THEN hits  END) AS h70,
        MAX(CASE WHEN threshold = 80 THEN picks END) AS p80,
        MAX(CASE WHEN threshold = 80 THEN hits  END) AS h80,
        MAX(CASE WHEN threshold = 90 THEN picks END) AS p90,
        MAX(CASE WHEN threshold = 90 THEN hits  END) AS h90
      FROM season_options
      GROUP BY win_label, option_name
    )
    SELECT win_label, option_name, '60-69' AS tier,
      COALESCE(p60,0) - COALESCE(p70,0) AS picks,
      COALESCE(h60,0) - COALESCE(h70,0) AS hits,
      CASE WHEN COALESCE(p60,0) - COALESCE(p70,0) > 0
           THEN ROUND(100.0 * (COALESCE(h60,0) - COALESCE(h70,0))
                / (COALESCE(p60,0) - COALESCE(p70,0)), 2) END AS wr
    FROM p
    UNION ALL
    SELECT win_label, option_name, '70-79',
      COALESCE(p70,0) - COALESCE(p80,0),
      COALESCE(h70,0) - COALESCE(h80,0),
      CASE WHEN COALESCE(p70,0) - COALESCE(p80,0) > 0
           THEN ROUND(100.0 * (COALESCE(h70,0) - COALESCE(h80,0))
                / (COALESCE(p70,0) - COALESCE(p80,0)), 2) END
    FROM p
    UNION ALL
    SELECT win_label, option_name, '80-89',
      COALESCE(p80,0) - COALESCE(p90,0),
      COALESCE(h80,0) - COALESCE(h90,0),
      CASE WHEN COALESCE(p80,0) - COALESCE(p90,0) > 0
           THEN ROUND(100.0 * (COALESCE(h80,0) - COALESCE(h90,0))
                / (COALESCE(p80,0) - COALESCE(p90,0)), 2) END
    FROM p
    UNION ALL
    SELECT win_label, option_name, '90+',
      COALESCE(p90,0), COALESCE(h90,0),
      CASE WHEN COALESCE(p90,0) > 0
           THEN ROUND(100.0 * COALESCE(h90,0) / COALESCE(p90,0), 2) END
    FROM p
    ORDER BY win_label, option_name, tier
  LOOP
    RAISE NOTICE '% | % | % | % | % | %',
      RPAD(r.win_label, 13), RPAD(r.option_name, 9), RPAD(r.tier, 7),
      LPAD(r.picks::TEXT, 6), LPAD(r.hits::TEXT, 6),
      LPAD(COALESCE(r.wr::TEXT, '—'), 7);
  END LOOP;

  -- ========================================================
  -- TASK 4 — Walk-forward decisions (synthetic train vs validate, thresh=70)
  -- ========================================================
  RAISE NOTICE '';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== TASK 4 — Walk-forward decisions (vs CURRENT on VALIDATE, thresh=70) ===';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '% | % | % | % | % | %',
    RPAD('option', 9), LPAD('train_wr', 9), LPAD('valid_wr', 9),
    LPAD('cur_valid', 9), LPAD('Δ vs cur', 9), RPAD('decision', 22);
  FOR r IN
    WITH per_option AS (
      SELECT
        option_name,
        MAX(CASE WHEN win_label = 'TRAIN_SYN'    AND threshold = 70 THEN win_pct END) AS train_wr,
        MAX(CASE WHEN win_label = 'VALIDATE_SYN' AND threshold = 70 THEN win_pct END) AS valid_wr
      FROM season_options
      GROUP BY option_name
    ),
    baseline AS (
      SELECT valid_wr AS cur_valid FROM per_option WHERE option_name = 'CURRENT'
    )
    SELECT
      po.option_name,
      po.train_wr,
      po.valid_wr,
      b.cur_valid,
      po.valid_wr - b.cur_valid AS delta_pp,
      CASE
        WHEN po.option_name = 'CURRENT' THEN '(baseline)'
        WHEN po.valid_wr IS NULL OR b.cur_valid IS NULL THEN 'INSUFFICIENT_DATA'
        WHEN (po.valid_wr - b.cur_valid) >  0.5 THEN 'APPROVE'
        WHEN (po.valid_wr - b.cur_valid) < -0.5 THEN 'REJECT_OVERFIT'
        ELSE 'NO_SIGNAL'
      END AS decision
    FROM per_option po CROSS JOIN baseline b
    ORDER BY po.option_name
  LOOP
    RAISE NOTICE '% | % | % | % | % | %',
      RPAD(r.option_name, 9),
      LPAD(COALESCE(r.train_wr::TEXT, '—'), 9),
      LPAD(COALESCE(r.valid_wr::TEXT, '—'), 9),
      LPAD(COALESCE(r.cur_valid::TEXT, '—'), 9),
      LPAD(COALESCE(ROUND(r.delta_pp, 2)::TEXT, '—'), 9),
      RPAD(r.decision, 22);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== DONE ===';
END $$;

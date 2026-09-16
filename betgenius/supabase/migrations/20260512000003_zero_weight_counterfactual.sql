-- Tier 1 #5 — Zero-weight reactivation counterfactual backtest (May 12).
-- READ-ONLY. Recomputes confidence per row under each config + baseline,
-- aggregates per-threshold + per-tier WR. Two corpora tested:
--   ORGANIC_LIVE — process-games is_synthetic=false post-May-4 (small but
--     trustworthy reflection of live engine; ~150 rows at 70+)
--   FULL_SYN — backfill is_synthetic=true Feb 1 - May 11 (~12k rows; NOTE:
--     full corpus was NOT re-replayed with Phase 2/3 fixes, so it carries
--     the pre-fix drift. Used here for sample-size comparison only.)
--
-- Configs (deltas from baseline = current production weights):
--   BASELINE  — current weights as-is (matches stored confidence within
--               cap rounding)
--   CONFIG_A  — w_ha_split = 1.0 (factor dead per signal audit; included
--               for completeness but expected zero effect)
--   CONFIG_B  — w_opp_defense = 1.0
--   CONFIG_C  — w_pace = 1.0
--   CONFIG_D  — w_minutes_trend = 1.0
--   CONFIG_E  — all 4 at 1.0
--   CONFIG_F  — all 4 at 0.5 (conservative)

DO $$
DECLARE
  cw RECORD;
  r RECORD;
BEGIN
  SELECT * INTO cw FROM algorithm_weights WHERE id = 1 LIMIT 1;

  CREATE TEMP TABLE results (
    win_label TEXT, option_name TEXT, threshold INT,
    picks BIGINT, hits BIGINT, win_pct NUMERIC, roi_pct NUMERIC
  ) ON COMMIT DROP;

  -- Two source corpora, joined as a UNION ALL for one-pass scoring.
  FOR r IN
    WITH rows AS (
      SELECT 'ORGANIC_LIVE'::TEXT AS win_label,
        hit, odds, score_trivial_line_cap,
        score_l5, score_l10, score_season, score_floor_ceiling, score_recent_form,
        score_home_away, score_rest, score_b2b, score_minutes_trend,
        score_pace, score_opp_defense, score_prop_type_penalty,
        score_z_score, score_role_change, score_vig_filter, score_usg_rate,
        score_regression, score_market_conf, score_home_away_split,
        score_minutes_volume, score_minutes_stability, score_consistency,
        score_stale_data, score_player_injury, score_trivial_line_penalty
      FROM pick_history
      WHERE source = 'process-games' AND is_synthetic = false
        AND created_at >= '2026-05-04'::timestamptz
        AND hit IS NOT NULL AND voided IS NOT TRUE
        AND prop_type NOT IN ('spread','game_total')
      UNION ALL
      SELECT 'FULL_SYN'::TEXT,
        hit, odds, score_trivial_line_cap,
        score_l5, score_l10, score_season, score_floor_ceiling, score_recent_form,
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
    ),
    options AS (
      SELECT rows.*,
        o.option_name,
        o.w_pace_o, o.w_opp_o, o.w_ha_o, o.w_mt_o
      FROM rows CROSS JOIN LATERAL (
        VALUES
          ('BASELINE'::TEXT, cw.w_pace::NUMERIC,        cw.w_opp_defense::NUMERIC, cw.w_ha_split::NUMERIC,   cw.w_minutes_trend::NUMERIC),
          ('CONFIG_A',       cw.w_pace::NUMERIC,        cw.w_opp_defense::NUMERIC, 1.0::NUMERIC,             cw.w_minutes_trend::NUMERIC),
          ('CONFIG_B',       cw.w_pace::NUMERIC,        1.0::NUMERIC,              cw.w_ha_split::NUMERIC,   cw.w_minutes_trend::NUMERIC),
          ('CONFIG_C',       1.0::NUMERIC,              cw.w_opp_defense::NUMERIC, cw.w_ha_split::NUMERIC,   cw.w_minutes_trend::NUMERIC),
          ('CONFIG_D',       cw.w_pace::NUMERIC,        cw.w_opp_defense::NUMERIC, cw.w_ha_split::NUMERIC,   1.0::NUMERIC),
          ('CONFIG_E',       1.0::NUMERIC,              1.0::NUMERIC,              1.0::NUMERIC,             1.0::NUMERIC),
          ('CONFIG_F',       0.5::NUMERIC,              0.5::NUMERIC,              0.5::NUMERIC,             0.5::NUMERIC)
      ) AS o(option_name, w_pace_o, w_opp_o, w_ha_o, w_mt_o)
    ),
    scored AS (
      SELECT win_label, option_name, hit, odds, score_trivial_line_cap,
        GREATEST(0, LEAST(100,
          50
          + ROUND(COALESCE(score_l5, 0)::NUMERIC * cw.w_l5)
          + ROUND(COALESCE(score_l10, 0)::NUMERIC * cw.w_l10)
          + ROUND(COALESCE(score_season, 0)::NUMERIC * cw.w_season)
          + ROUND(COALESCE(score_floor_ceiling, 0)::NUMERIC * cw.w_floor_ceiling)
          + ROUND(COALESCE(score_recent_form, 0)::NUMERIC * cw.w_recent_form)
          + ROUND(COALESCE(score_home_away, 0)::NUMERIC * cw.w_home_away)
          + ROUND(COALESCE(score_rest, 0)::NUMERIC * cw.w_rest)
          + ROUND(COALESCE(score_b2b, 0)::NUMERIC * cw.w_b2b)
          + ROUND(COALESCE(score_minutes_trend, 0)::NUMERIC * w_mt_o)
          + ROUND(COALESCE(score_pace, 0)::NUMERIC * w_pace_o)
          + ROUND(COALESCE(score_opp_defense, 0)::NUMERIC * w_opp_o)
          + ROUND(COALESCE(score_prop_type_penalty, 0)::NUMERIC * cw.w_prop_type)
          + ROUND(COALESCE(score_z_score, 0)::NUMERIC * cw.w_z_score)
          + ROUND(COALESCE(score_role_change, 0)::NUMERIC * cw.w_role_change)
          + ROUND(COALESCE(score_vig_filter, 0)::NUMERIC * cw.w_vig_filter)
          + ROUND(COALESCE(score_usg_rate, 0)::NUMERIC * cw.w_usg_rate)
          + ROUND(COALESCE(score_regression, 0)::NUMERIC * cw.w_regression)
          + ROUND(COALESCE(score_market_conf, 0)::NUMERIC * cw.w_market_conf)
          + ROUND(COALESCE(score_home_away_split, 0)::NUMERIC * w_ha_o)
          + ROUND(COALESCE(score_minutes_volume, 0)::NUMERIC * cw.w_minutes_floor)
          + ROUND(COALESCE(score_minutes_stability, 0)::NUMERIC * cw.w_minutes_floor)
          + ROUND(COALESCE(score_consistency, 0)::NUMERIC * cw.w_consistency)
          + ROUND(COALESCE(score_stale_data, 0)::NUMERIC * cw.w_stale_data)
          + ROUND(COALESCE(score_player_injury, 0)::NUMERIC * cw.w_player_injury)
          + COALESCE(score_trivial_line_penalty, 0)::NUMERIC
        )) AS raw_conf
      FROM options
    ),
    capped AS (
      SELECT win_label, option_name, hit, odds,
        CASE WHEN COALESCE(score_trivial_line_cap, false) AND raw_conf > 65 THEN 65 ELSE raw_conf END AS conf
      FROM scored
    ),
    final AS (
      SELECT win_label, option_name, t.threshold,
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
    INSERT INTO results VALUES (r.win_label, r.option_name, r.threshold, r.picks, r.hits, r.win_pct, r.roi_pct);
  END LOOP;

  -- Cumulative output
  RAISE NOTICE '';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== CUMULATIVE (at-or-above threshold) ===';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '% | % | % | % | % | % | %',
    RPAD('window', 13), RPAD('option', 9), LPAD('thresh', 6),
    LPAD('picks', 6), LPAD('hits', 6), LPAD('wr%', 7), LPAD('roi%', 7);
  FOR r IN SELECT * FROM results ORDER BY win_label, option_name, threshold LOOP
    RAISE NOTICE '% | % | % | % | % | % | %',
      RPAD(r.win_label, 13), RPAD(r.option_name, 9), LPAD(r.threshold::TEXT, 6),
      LPAD(r.picks::TEXT, 6), LPAD(r.hits::TEXT, 6),
      LPAD(COALESCE(r.win_pct::TEXT, '—'), 7),
      LPAD(COALESCE(r.roi_pct::TEXT, '—'), 7);
  END LOOP;

  -- Per-tier breakdown via cumulative subtraction
  RAISE NOTICE '';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== PER-TIER (mutually exclusive bands) ===';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '% | % | % | % | % | %',
    RPAD('window', 13), RPAD('option', 9), RPAD('tier', 7),
    LPAD('picks', 6), LPAD('hits', 6), LPAD('wr%', 7);
  FOR r IN
    WITH p AS (
      SELECT win_label, option_name,
        MAX(CASE WHEN threshold = 60 THEN picks END) AS p60,
        MAX(CASE WHEN threshold = 60 THEN hits END) AS h60,
        MAX(CASE WHEN threshold = 70 THEN picks END) AS p70,
        MAX(CASE WHEN threshold = 70 THEN hits END) AS h70,
        MAX(CASE WHEN threshold = 80 THEN picks END) AS p80,
        MAX(CASE WHEN threshold = 80 THEN hits END) AS h80,
        MAX(CASE WHEN threshold = 90 THEN picks END) AS p90,
        MAX(CASE WHEN threshold = 90 THEN hits END) AS h90
      FROM results GROUP BY win_label, option_name
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
      COALESCE(p70,0) - COALESCE(p80,0), COALESCE(h70,0) - COALESCE(h80,0),
      CASE WHEN COALESCE(p70,0) - COALESCE(p80,0) > 0
           THEN ROUND(100.0 * (COALESCE(h70,0) - COALESCE(h80,0))
                / (COALESCE(p70,0) - COALESCE(p80,0)), 2) END
    FROM p
    UNION ALL
    SELECT win_label, option_name, '80-89',
      COALESCE(p80,0) - COALESCE(p90,0), COALESCE(h80,0) - COALESCE(h90,0),
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
END $$;

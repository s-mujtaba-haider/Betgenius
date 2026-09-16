-- ML Optimizer Upgrade Phase 1 — windowed backtest variant for walk-forward
-- validation (May 7, 2026 evening).
--
-- Foundation for walk-forward validation: enables training on Feb-Mar
-- synthetic data and validating on Apr-May synthetic data (or any
-- arbitrary window). Catches optimizers that find spurious "improvements"
-- by overfitting to noise — true signals persist across train/validate
-- windows; noise spikes don't.
--
-- ADDITIVE only: existing backtest_weights_v3_synthetic stays live and
-- unchanged. New function shares the same scoring math but adds:
--   - start_date_param DATE: lower bound of created_at filter (inclusive)
--   - end_date_param DATE: upper bound (inclusive — added 1 day internally)
--   - is_synthetic_filter BOOLEAN DEFAULT true: lets us use this against
--     organic data later when accumulated; for now defaults to synthetic
--
-- Note on date filtering: synthetic rows have backdated created_at to
-- game_date 8pm UTC (per scoreSlateForDate). So filtering by created_at
-- approximates filtering by game date. This is fine for walk-forward —
-- the bias is consistent across train and validate windows.
--
-- Per session constraints:
--   - DO NOT modify backtest_weights_v3_synthetic body
--   - DO NOT modify backtest_weights_v3 body
--   - DO NOT change algorithm_weights values
--   - DO NOT change cron schedule (jobid 11 + jobid 12 stay as-is)

CREATE OR REPLACE FUNCTION backtest_weights_v3_synthetic_windowed(
  start_date_param DATE,
  end_date_param DATE,
  w_l5 NUMERIC DEFAULT 1.0,             w_l10 NUMERIC DEFAULT 0.75,
  w_season NUMERIC DEFAULT 1.75,        w_floor_ceiling NUMERIC DEFAULT 1.5,
  w_recent_form NUMERIC DEFAULT 1.5,    w_home_away NUMERIC DEFAULT 1.0,
  w_rest NUMERIC DEFAULT 1.0,           w_b2b NUMERIC DEFAULT 2.25,
  w_minutes_trend NUMERIC DEFAULT 0.0,  w_pace NUMERIC DEFAULT 0.5,
  w_opp_defense NUMERIC DEFAULT 0.0,    w_prop_type NUMERIC DEFAULT 0.25,
  w_z_score NUMERIC DEFAULT 0.25,       w_role_change NUMERIC DEFAULT 2.0,
  w_vig_filter NUMERIC DEFAULT 0.5,     w_usg_rate NUMERIC DEFAULT 1.0,
  w_regression NUMERIC DEFAULT 1.0,     w_market_conf NUMERIC DEFAULT 2.0,
  w_ha_split NUMERIC DEFAULT 0.0,       w_minutes_floor NUMERIC DEFAULT 2.5,
  w_consistency NUMERIC DEFAULT 1.0,    w_stale_data NUMERIC DEFAULT 2.25,
  w_player_injury NUMERIC DEFAULT 0.75,
  is_synthetic_filter BOOLEAN DEFAULT true
)
RETURNS TABLE (
  threshold INTEGER, picks BIGINT, hits BIGINT, win_pct NUMERIC, roi_pct NUMERIC
) AS $$
  WITH scored AS (
    SELECT
      hit, odds, score_trivial_line_cap,
      GREATEST(0, LEAST(100,
        50
        + ROUND(COALESCE(score_l5, 0)::NUMERIC * w_l5)
        + ROUND(COALESCE(score_l10, 0)::NUMERIC * w_l10)
        + ROUND(COALESCE(score_season, 0)::NUMERIC * w_season)
        + ROUND(COALESCE(score_floor_ceiling, 0)::NUMERIC * w_floor_ceiling)
        + ROUND(COALESCE(score_recent_form, 0)::NUMERIC * w_recent_form)
        + ROUND(COALESCE(score_home_away, 0)::NUMERIC * w_home_away)
        + ROUND(COALESCE(score_rest, 0)::NUMERIC * w_rest)
        + ROUND(COALESCE(score_b2b, 0)::NUMERIC * w_b2b)
        + ROUND(COALESCE(score_minutes_trend, 0)::NUMERIC * w_minutes_trend)
        + ROUND(COALESCE(score_pace, 0)::NUMERIC * w_pace)
        + ROUND(COALESCE(score_opp_defense, 0)::NUMERIC * w_opp_defense)
        + ROUND(COALESCE(score_prop_type_penalty, 0)::NUMERIC * w_prop_type)
        + ROUND(COALESCE(score_z_score, 0)::NUMERIC * w_z_score)
        + ROUND(COALESCE(score_role_change, 0)::NUMERIC * w_role_change)
        + ROUND(COALESCE(score_vig_filter, 0)::NUMERIC * w_vig_filter)
        + ROUND(COALESCE(score_usg_rate, 0)::NUMERIC * w_usg_rate)
        + ROUND(COALESCE(score_regression, 0)::NUMERIC * w_regression)
        + ROUND(COALESCE(score_market_conf, 0)::NUMERIC * w_market_conf)
        + ROUND(COALESCE(score_home_away_split, 0)::NUMERIC * w_ha_split)
        + ROUND(COALESCE(score_minutes_volume, 0)::NUMERIC * w_minutes_floor)
        + ROUND(COALESCE(score_minutes_stability, 0)::NUMERIC * w_minutes_floor)
        + ROUND(COALESCE(score_consistency, 0)::NUMERIC * w_consistency)
        + ROUND(COALESCE(score_stale_data, 0)::NUMERIC * w_stale_data)
        + ROUND(COALESCE(score_player_injury, 0)::NUMERIC * w_player_injury)
        + COALESCE(score_trivial_line_penalty, 0)::NUMERIC
      )) AS raw_reconstructed
    FROM pick_history
    WHERE is_synthetic = is_synthetic_filter
      AND hit IS NOT NULL
      AND prop_type NOT IN ('spread', 'game_total')
      AND created_at >= start_date_param::timestamptz
      AND created_at < (end_date_param + INTERVAL '1 day')::timestamptz
  ),
  capped AS (
    SELECT hit, odds,
      CASE
        WHEN COALESCE(score_trivial_line_cap, false) AND raw_reconstructed > 65 THEN 65
        ELSE raw_reconstructed
      END AS reconstructed_confidence
    FROM scored
  )
  SELECT
    t.threshold::INTEGER,
    COUNT(*)::BIGINT AS picks,
    SUM(CASE WHEN hit THEN 1 ELSE 0 END)::BIGINT AS hits,
    ROUND(100.0 * SUM(CASE WHEN hit THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 2) AS win_pct,
    ROUND(100.0 * SUM(
      CASE WHEN hit THEN
        CASE WHEN odds > 0 THEN odds::NUMERIC ELSE 10000.0 / ABS(odds::NUMERIC) END
      ELSE -100 END
    ) / NULLIF(COUNT(*), 0) / 100, 2) AS roi_pct
  FROM capped
  CROSS JOIN (VALUES (60), (65), (70), (75), (80), (85), (90)) AS t(threshold)
  WHERE reconstructed_confidence >= t.threshold
  GROUP BY t.threshold
  ORDER BY t.threshold;
$$ LANGUAGE SQL STABLE;

ALTER FUNCTION backtest_weights_v3_synthetic_windowed(
  DATE, DATE,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC,
  BOOLEAN
) SET statement_timeout = '60s';

COMMENT ON FUNCTION backtest_weights_v3_synthetic_windowed IS
  'Walk-forward variant of backtest_weights_v3_synthetic (May 7 ML upgrade '
  'Phase 1). Adds (start_date_param, end_date_param, is_synthetic_filter) '
  'parameters to enable training on one date range and validating on another. '
  'Same scoring math as backtest_weights_v3_synthetic; existing function '
  'untouched. Used by optimize_weights_walk_forward (Phase 4).';

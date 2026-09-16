-- compute_calibration_snapshot(window_type, snapshot_date)
-- Returns one row per (metric_type, metric_key) for the given window.
-- May 11, 2026.

CREATE OR REPLACE FUNCTION public.compute_calibration_snapshot(
  p_window_type TEXT,
  p_snapshot_date DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  metric_type           TEXT,
  metric_key            TEXT,
  bets_count            INTEGER,
  bets_resolved         INTEGER,
  bets_hit              INTEGER,
  hit_rate              NUMERIC,
  avg_confidence        NUMERIC,
  backtest_hit_rate     NUMERIC,
  calibration_delta     NUMERIC
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_window_start DATE;
BEGIN
  v_window_start := CASE p_window_type
    WHEN 'rolling_7d'  THEN p_snapshot_date - 7
    WHEN 'rolling_30d' THEN p_snapshot_date - 30
    WHEN 'all_time'    THEN '2026-01-01'::DATE
    ELSE p_snapshot_date - 30  -- default to 30d
  END;

  -- Reference synthetic backtest hit rates per tier (snapshot from
  -- backfill cleanup baseline May 7 — these are the algorithm's own
  -- expectation for each tier and rarely shift week-over-week. Update
  -- when auto-optimizer changes weights materially).
  -- Source: /tmp/c40_fix_summary_may9.md tier rates on 12,497 synthetic
  -- corpus. Values shown as decimal fractions (e.g. 0.7180 = 71.80%).
  --   90+ : 0.7180  (96 picks)
  --   80-89 : 0.6240  (142 picks)
  --   70-79 : 0.5770  (336 picks)
  --   60-69 : 0.5650  (626 picks)
  --   <60 : 0.5290  (10,303 picks; defensive, not user-facing)

  RETURN QUERY
  WITH base AS (
    SELECT
      ci.bet_id,
      ci.confidence,
      ci.confidence_tier,
      ci.prop_type,
      ci.score_player_injury,
      ci.score_l5,
      ci.hit,
      ci.voided
    FROM public.calibration_input ci
    WHERE ci.bet_date >= v_window_start
      AND ci.bet_date <= p_snapshot_date
  ),

  -- (1) overall
  overall_metric AS (
    SELECT
      'overall'::TEXT             AS metric_type,
      'all'::TEXT                 AS metric_key,
      COUNT(*)::INTEGER           AS bets_count,
      COUNT(*) FILTER (WHERE hit IS NOT NULL)::INTEGER AS bets_resolved,
      COUNT(*) FILTER (WHERE hit = true)::INTEGER       AS bets_hit,
      CASE
        WHEN COUNT(*) FILTER (WHERE hit IS NOT NULL) = 0 THEN NULL
        ELSE ROUND(
          COUNT(*) FILTER (WHERE hit = true)::NUMERIC /
          COUNT(*) FILTER (WHERE hit IS NOT NULL)::NUMERIC,
          4
        )
      END AS hit_rate,
      ROUND(AVG(confidence)::NUMERIC, 2) AS avg_confidence,
      NULL::NUMERIC                AS backtest_hit_rate,
      NULL::NUMERIC                AS calibration_delta
    FROM base
  ),

  -- (2) by tier
  tier_metric AS (
    SELECT
      'tier'::TEXT                AS metric_type,
      confidence_tier             AS metric_key,
      COUNT(*)::INTEGER           AS bets_count,
      COUNT(*) FILTER (WHERE hit IS NOT NULL)::INTEGER AS bets_resolved,
      COUNT(*) FILTER (WHERE hit = true)::INTEGER       AS bets_hit,
      CASE
        WHEN COUNT(*) FILTER (WHERE hit IS NOT NULL) = 0 THEN NULL
        ELSE ROUND(
          COUNT(*) FILTER (WHERE hit = true)::NUMERIC /
          COUNT(*) FILTER (WHERE hit IS NOT NULL)::NUMERIC,
          4
        )
      END AS hit_rate,
      ROUND(AVG(confidence)::NUMERIC, 2) AS avg_confidence,
      CASE confidence_tier
        WHEN '90+'   THEN 0.7180::NUMERIC
        WHEN '80-89' THEN 0.6240::NUMERIC
        WHEN '70-79' THEN 0.5770::NUMERIC
        WHEN '60-69' THEN 0.5650::NUMERIC
        WHEN '<60'   THEN 0.5290::NUMERIC
      END AS backtest_hit_rate,
      -- calibration_delta = actual_hit_rate - implied_probability_from_confidence
      -- where implied = avg_confidence/100 (treat confidence as probability proxy).
      -- Positive delta = bets winning MORE than confidence suggests (good — bookmakers
      -- under-pricing our edge). Negative = algorithm overconfident vs reality.
      CASE
        WHEN COUNT(*) FILTER (WHERE hit IS NOT NULL) = 0 THEN NULL
        ELSE ROUND(
          (COUNT(*) FILTER (WHERE hit = true)::NUMERIC /
            COUNT(*) FILTER (WHERE hit IS NOT NULL)::NUMERIC) -
          (AVG(confidence)::NUMERIC / 100.0),
          4
        )
      END AS calibration_delta
    FROM base
    WHERE confidence_tier IS NOT NULL
    GROUP BY confidence_tier
  ),

  -- (3) by prop_type
  prop_metric AS (
    SELECT
      'prop_type'::TEXT           AS metric_type,
      prop_type                   AS metric_key,
      COUNT(*)::INTEGER           AS bets_count,
      COUNT(*) FILTER (WHERE hit IS NOT NULL)::INTEGER AS bets_resolved,
      COUNT(*) FILTER (WHERE hit = true)::INTEGER       AS bets_hit,
      CASE
        WHEN COUNT(*) FILTER (WHERE hit IS NOT NULL) = 0 THEN NULL
        ELSE ROUND(
          COUNT(*) FILTER (WHERE hit = true)::NUMERIC /
          COUNT(*) FILTER (WHERE hit IS NOT NULL)::NUMERIC,
          4
        )
      END AS hit_rate,
      ROUND(AVG(confidence)::NUMERIC, 2) AS avg_confidence,
      NULL::NUMERIC                AS backtest_hit_rate,
      NULL::NUMERIC                AS calibration_delta
    FROM base
    WHERE prop_type IS NOT NULL
    GROUP BY prop_type
  ),

  -- (4) factor presence: split on score_player_injury <> 0 (player WAS on
  -- injury list with penalty applied) vs = 0 (no injury impact). Tighter
  -- signal than presence of any score_* column. Extend to other factors
  -- in future sessions if useful.
  factor_metric AS (
    SELECT
      'factor_presence'::TEXT     AS metric_type,
      CASE
        WHEN ABS(COALESCE(score_player_injury, 0)) > 0.01
          THEN 'score_player_injury_present'
        ELSE 'score_player_injury_absent'
      END                          AS metric_key,
      COUNT(*)::INTEGER            AS bets_count,
      COUNT(*) FILTER (WHERE hit IS NOT NULL)::INTEGER AS bets_resolved,
      COUNT(*) FILTER (WHERE hit = true)::INTEGER       AS bets_hit,
      CASE
        WHEN COUNT(*) FILTER (WHERE hit IS NOT NULL) = 0 THEN NULL
        ELSE ROUND(
          COUNT(*) FILTER (WHERE hit = true)::NUMERIC /
          COUNT(*) FILTER (WHERE hit IS NOT NULL)::NUMERIC,
          4
        )
      END AS hit_rate,
      ROUND(AVG(confidence)::NUMERIC, 2) AS avg_confidence,
      NULL::NUMERIC                AS backtest_hit_rate,
      NULL::NUMERIC                AS calibration_delta
    FROM base
    GROUP BY
      CASE
        WHEN ABS(COALESCE(score_player_injury, 0)) > 0.01
          THEN 'score_player_injury_present'
        ELSE 'score_player_injury_absent'
      END
  )

  SELECT * FROM overall_metric
  UNION ALL
  SELECT * FROM tier_metric
  UNION ALL
  SELECT * FROM prop_metric
  UNION ALL
  SELECT * FROM factor_metric;
END;
$$;

COMMENT ON FUNCTION public.compute_calibration_snapshot(TEXT, DATE) IS
  'Returns calibration metric rows for a given window. Used by '
  'write_calibration_snapshot (daily cron). Reference backtest_hit_rate '
  'values per tier are static constants from the 12,497-row synthetic corpus '
  '(May 7 backfill) — update when auto-optimizer materially shifts weights.';

-- Migration: 002_backtest_weights_v2
-- Created: 2026-04-22
-- Purpose: Additive replacement for broken backtest_weights() function.
--          The existing backtest_weights() reports win rates that diverge
--          materially from production. v2 reconstructs confidence by re-applying
--          a candidate weight set to the RAW factor scores stored in pick_history,
--          then tiers the results by threshold. Mirrors production's
--          calculateConfidenceScore + scoreOneSide cascade exactly, including:
--            - WEIGHTS.rest multiplier (wired into production in commit 556e07a)
--            - b2b applied RAW (no weight multiplier — matches production)
--            - trivial line penalty (-15 / -8)
--            - trivial cap at 65 for line <= 0.5 AND odds >= +200
--            - clamp to [0, 100]
--
-- DOES NOT DROP OR MODIFY existing backtest_weights(). v2 is strictly additive.
-- DO NOT schedule auto-optimize against this until validation passes.

CREATE OR REPLACE FUNCTION backtest_weights_v2(
  w_l5 NUMERIC DEFAULT 1.0,
  w_l10 NUMERIC DEFAULT 0.0,
  w_season NUMERIC DEFAULT 1.75,
  w_floor_ceiling NUMERIC DEFAULT 1.5,
  w_recent_form NUMERIC DEFAULT 1.5,
  w_home_away NUMERIC DEFAULT 0.0,
  w_rest NUMERIC DEFAULT 1.0,
  w_minutes_trend NUMERIC DEFAULT 0.0,
  w_pace NUMERIC DEFAULT 0.5,
  w_opp_defense NUMERIC DEFAULT 0.0,
  w_prop_type NUMERIC DEFAULT 0.25,
  w_z_score NUMERIC DEFAULT 0.25,
  w_role_change NUMERIC DEFAULT 2.0,
  w_vig_filter NUMERIC DEFAULT 0.0,
  w_usg_rate NUMERIC DEFAULT 1.0,
  w_regression NUMERIC DEFAULT 1.0,
  w_market_conf NUMERIC DEFAULT 2.0,
  w_ha_split NUMERIC DEFAULT 0.0,
  w_minutes_floor NUMERIC DEFAULT 2.5,
  w_consistency NUMERIC DEFAULT 1.0,
  w_stale_data NUMERIC DEFAULT 2.25,
  w_player_injury NUMERIC DEFAULT 0.75
)
RETURNS TABLE (
  threshold INTEGER,
  picks BIGINT,
  hits BIGINT,
  win_pct NUMERIC,
  roi_pct NUMERIC
) AS $$
  WITH scored AS (
    SELECT
      hit,
      odds,
      line,
      GREATEST(0, LEAST(100,
        50
        + ROUND(COALESCE(score_l5, 0)::NUMERIC * w_l5)
        + ROUND(COALESCE(score_l10, 0)::NUMERIC * w_l10)
        + ROUND(COALESCE(score_season, 0)::NUMERIC * w_season)
        + ROUND(COALESCE(score_floor_ceiling, 0)::NUMERIC * w_floor_ceiling)
        + ROUND(COALESCE(score_recent_form, 0)::NUMERIC * w_recent_form)
        + ROUND(COALESCE(score_home_away, 0)::NUMERIC * w_home_away)
        + ROUND(COALESCE(score_rest, 0)::NUMERIC * w_rest)
        + COALESCE(score_b2b, 0)  -- b2b is applied RAW in production, no weight multiply
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
        + ROUND(COALESCE(score_minutes_floor, 0)::NUMERIC * w_minutes_floor)
        + ROUND(COALESCE(score_consistency, 0)::NUMERIC * w_consistency)
        + ROUND(COALESCE(score_stale_data, 0)::NUMERIC * w_stale_data)
        + ROUND(COALESCE(score_player_injury, 0)::NUMERIC * w_player_injury)
        -- Trivial line penalty (mirrors production):
        --   isTrivialLine (line <= 0.5) && trivialOdds (odds >= +200) → -15
        --   isTrivialLine alone → -8
        + CASE
            WHEN line <= 0.5 AND odds >= 200 THEN -15
            WHEN line <= 0.5 THEN -8
            ELSE 0
          END
      )) AS raw_reconstructed,
      (line <= 0.5 AND odds >= 200) AS is_double_trivial
    FROM pick_history
    WHERE voided = false
      AND hit IS NOT NULL
      AND source IN ('process-games', 'dashboard')  -- exclude analyze-pick (C10 score_season semantic drift)
      AND prop_type NOT IN ('spread', 'game_total')  -- player props only
  ),
  capped AS (
    SELECT
      hit,
      odds,
      CASE
        WHEN is_double_trivial AND raw_reconstructed > 65 THEN 65
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
  CROSS JOIN (VALUES (70), (75), (80), (85)) AS t(threshold)
  WHERE reconstructed_confidence >= t.threshold
  GROUP BY t.threshold
  ORDER BY t.threshold;
$$ LANGUAGE SQL STABLE;

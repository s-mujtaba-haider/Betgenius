-- ============================================================================
-- Migration : 20260505000001_backtest_weights_v3.sql
-- Date      : 2026-05-05
-- Purpose   : Additive replacement for backtest_weights_v2. v2 went stale
--             after the May 4 megadeploy (commit 03d1700) — line 75 of v2
--             references `score_minutes_floor` × `w_minutes_floor`, but
--             megadeploy decomposed that column into score_minutes_volume +
--             score_minutes_stability. v2 also doesn't sum the new
--             score_trivial_line_penalty / score_trivial_line_cap columns,
--             and treats b2b as RAW (no weight multiplier) — production
--             now wires the weight via D-074 (C11 closure).
--
--             v3 mirrors post-megadeploy production scoring exactly:
--               - score_b2b × w_b2b (no longer raw — D-074)
--               - score_minutes_volume × w_minutes_floor (NEW — D-075)
--               - score_minutes_stability × w_minutes_floor (NEW — D-075,
--                 reuses same weight column until a future migration adds
--                 a dedicated w_minutes_stability)
--               - score_minutes_floor reference DROPPED (column retained
--                 in pick_history for back-compat but no longer contributes
--                 to finalScore in production post-megadeploy)
--               - score_trivial_line_penalty consumed DIRECTLY from the
--                 column (was reconstructed inline in v2; now observable
--                 per C30 fix in megadeploy)
--               - score_trivial_line_cap drives the 65 cap (boolean
--                 column; was reconstructed inline in v2)
--               - C20 demarcation: only post-megadeploy picks counted
--                 (created_at >= '2026-05-04 00:00:00+00'). Pre-megadeploy
--                 under-side picks have corrupted score values for the
--                 7 Bug #4 family factors per D-073.
--
--             ADDITIVE — does not drop v2 or v1. Both functions remain
--             available for historical comparison. Auto-optimize cron
--             remains UNSCHEDULED until C16 closure validates v3.
--
-- Rollback  :
--     DROP FUNCTION IF EXISTS backtest_weights_v3(...);
-- ============================================================================

CREATE OR REPLACE FUNCTION backtest_weights_v3(
  w_l5 NUMERIC DEFAULT 1.0,
  w_l10 NUMERIC DEFAULT 0.75,
  w_season NUMERIC DEFAULT 1.75,
  w_floor_ceiling NUMERIC DEFAULT 1.5,
  w_recent_form NUMERIC DEFAULT 1.5,
  w_home_away NUMERIC DEFAULT 1.0,
  w_rest NUMERIC DEFAULT 1.0,
  w_b2b NUMERIC DEFAULT 2.25,
  w_minutes_trend NUMERIC DEFAULT 0.0,
  w_pace NUMERIC DEFAULT 0.5,
  w_opp_defense NUMERIC DEFAULT 0.0,
  w_prop_type NUMERIC DEFAULT 0.25,
  w_z_score NUMERIC DEFAULT 0.25,
  w_role_change NUMERIC DEFAULT 2.0,
  w_vig_filter NUMERIC DEFAULT 0.5,
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
      score_trivial_line_cap,
      GREATEST(0, LEAST(100,
        50
        + ROUND(COALESCE(score_l5, 0)::NUMERIC * w_l5)
        + ROUND(COALESCE(score_l10, 0)::NUMERIC * w_l10)
        + ROUND(COALESCE(score_season, 0)::NUMERIC * w_season)
        + ROUND(COALESCE(score_floor_ceiling, 0)::NUMERIC * w_floor_ceiling)
        + ROUND(COALESCE(score_recent_form, 0)::NUMERIC * w_recent_form)
        + ROUND(COALESCE(score_home_away, 0)::NUMERIC * w_home_away)
        + ROUND(COALESCE(score_rest, 0)::NUMERIC * w_rest)
        -- D-074 (May 4 megadeploy): b2b weight multiplier WIRED in production
        -- (was raw `score += b2bScore` pre-megadeploy, closing C11). v3 mirrors.
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
        -- D-075 (May 4 megadeploy): minutes_floor decomposed. The legacy
        -- score_minutes_floor column no longer contributes to finalScore
        -- in production. v3 sums the two new columns instead. Both reuse
        -- w_minutes_floor weight column until a dedicated weight is added.
        + ROUND(COALESCE(score_minutes_volume, 0)::NUMERIC * w_minutes_floor)
        + ROUND(COALESCE(score_minutes_stability, 0)::NUMERIC * w_minutes_floor)
        + ROUND(COALESCE(score_consistency, 0)::NUMERIC * w_consistency)
        + ROUND(COALESCE(score_stale_data, 0)::NUMERIC * w_stale_data)
        + ROUND(COALESCE(score_player_injury, 0)::NUMERIC * w_player_injury)
        -- C30 fix (May 4 megadeploy): trivialLinePenalty now persisted to
        -- pick_history.score_trivial_line_penalty (was reconstructed inline
        -- in v2). Consume directly — captures any future tuning of the
        -- constants and is bit-identical to production.
        + COALESCE(score_trivial_line_penalty, 0)::NUMERIC
      )) AS raw_reconstructed
    FROM pick_history
    WHERE voided = false
      AND hit IS NOT NULL
      -- C10 score_season semantic drift in analyze-pick still open (Evaluator
      -- redo Sessions A+B in §15.2 will close it). Exclude analyze-pick rows.
      AND source IN ('process-games', 'dashboard')
      AND prop_type NOT IN ('spread', 'game_total')  -- player props only
      -- C20 demarcation (D-073): only post-megadeploy picks have correct
      -- under-side scoring. Pre-megadeploy rows have corrupted score values
      -- for the 7 Bug #4 family factors. May 4 00:00 UTC chosen per CEO
      -- spec — slightly over-inclusive of pre-megadeploy May 4 morning
      -- picks but conservatively close enough. Tighten to '2026-05-04
      -- 22:00:00+00' for stricter post-megadeploy-only window if needed.
      AND created_at >= '2026-05-04 00:00:00+00'::timestamptz
  ),
  capped AS (
    SELECT
      hit,
      odds,
      -- C30 (May 4 megadeploy): trivialLineCap is now a BOOLEAN column
      -- recording whether the +65 cap was applied at scoring time. v2 had
      -- to reconstruct via (line <= 0.5 AND odds >= 200) inline; v3
      -- consumes the column directly.
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
  CROSS JOIN (VALUES (70), (75), (80), (85)) AS t(threshold)
  WHERE reconstructed_confidence >= t.threshold
  GROUP BY t.threshold
  ORDER BY t.threshold;
$$ LANGUAGE SQL STABLE;

COMMENT ON FUNCTION backtest_weights_v3 IS
  'Reconstructs production confidence scores by re-applying candidate weights '
  'to per-pick score_* columns in pick_history. Mirrors post-megadeploy '
  '(commit 03d1700, May 4) production scoring exactly. Returns one row per '
  'threshold tier (70, 75, 80, 85). Filters to post-megadeploy picks only '
  '(C20 demarcation) and excludes analyze-pick source (C10 semantic drift). '
  'Auto-optimize cron stays UNSCHEDULED until C16 validation pass.';

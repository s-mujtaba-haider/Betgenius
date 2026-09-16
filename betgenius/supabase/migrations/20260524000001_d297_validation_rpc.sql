-- D-297 SHIP 4 (2026-05-24) — validation tracking RPC.
--
-- Tracks Elite (conf >= 90) MLB game_side WR per day across the
-- validation window. CEO can call this anytime to see how the
-- D-297 SHIP 1 surgical suppression is performing on fresh picks.
--
-- Baseline (pre-D-297): MLB Elite game_side n=69 WR 58.0% (home 46.3% / away 75.0%)
-- Target: Elite game_side WR ≥65% on n≥20 across 7-day validation window.
--
-- Rollback: DROP FUNCTION IF EXISTS get_d297_validation_status();

CREATE OR REPLACE FUNCTION get_d297_validation_status()
RETURNS TABLE (
  bucket TEXT,
  game_date_range TEXT,
  elite_n BIGINT,
  elite_hits BIGINT,
  elite_misses BIGINT,
  elite_pushes BIGINT,
  elite_voided BIGINT,
  elite_unresolved BIGINT,
  elite_wr_pct NUMERIC,
  suppression_triggered_count BIGINT,
  status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH base AS (
    SELECT
      ph.id,
      ph.game_date,
      ph.confidence,
      ph.hit,
      ph.voided,
      ph.resolved_at,
      ph.pick_side,
      ph.prop_type,
      ph.mlb_market_type,
      -- D-297 SHIP 1 transparency: pick_history doesn't store the
      -- suppression flag explicitly, so we infer it from breakdown
      -- on recommendations_cache if needed. For audit purposes here
      -- we just count Elite picks per period.
      CASE
        WHEN ph.game_date >= '2026-05-24' THEN 'POST_D297'
        WHEN ph.game_date >= '2026-05-18' THEN 'PRE_D297_BASELINE'
        ELSE 'EARLIER'
      END AS bucket_label,
      CASE
        WHEN ph.game_date >= '2026-05-24' THEN '2026-05-24+'
        WHEN ph.game_date >= '2026-05-18' THEN '2026-05-18..2026-05-23'
        ELSE 'pre 2026-05-18'
      END AS dr
    FROM pick_history ph
    WHERE ph.sport = 'mlb'
      AND ph.confidence >= 90
      AND ph.mlb_market_type = 'game_side'
  )
  SELECT
    bucket_label::TEXT,
    dr::TEXT,
    COUNT(*)::BIGINT AS elite_n,
    COUNT(*) FILTER (WHERE hit = TRUE)::BIGINT AS elite_hits,
    COUNT(*) FILTER (WHERE hit = FALSE)::BIGINT AS elite_misses,
    COUNT(*) FILTER (WHERE hit IS NULL AND resolved_at IS NOT NULL AND voided = FALSE)::BIGINT AS elite_pushes,
    COUNT(*) FILTER (WHERE voided = TRUE)::BIGINT AS elite_voided,
    COUNT(*) FILTER (WHERE resolved_at IS NULL AND voided = FALSE)::BIGINT AS elite_unresolved,
    CASE WHEN COUNT(*) FILTER (WHERE hit IN (TRUE, FALSE)) > 0
      THEN ROUND(100.0 * COUNT(*) FILTER (WHERE hit = TRUE)::numeric / COUNT(*) FILTER (WHERE hit IN (TRUE, FALSE)), 1)
      ELSE 0
    END AS elite_wr_pct,
    0::BIGINT AS suppression_triggered_count, -- not stored on pick_history; see recommendations_cache.breakdown
    CASE
      WHEN COUNT(*) FILTER (WHERE hit IN (TRUE, FALSE)) < 20 THEN 'INSUFFICIENT_DATA'
      WHEN ROUND(100.0 * COUNT(*) FILTER (WHERE hit = TRUE)::numeric / COUNT(*) FILTER (WHERE hit IN (TRUE, FALSE)), 1) >= 65 THEN 'PASS'
      WHEN ROUND(100.0 * COUNT(*) FILTER (WHERE hit = TRUE)::numeric / COUNT(*) FILTER (WHERE hit IN (TRUE, FALSE)), 1) >= 58 THEN 'MARGINAL'
      WHEN ROUND(100.0 * COUNT(*) FILTER (WHERE hit = TRUE)::numeric / COUNT(*) FILTER (WHERE hit IN (TRUE, FALSE)), 1) < 50 THEN 'CATASTROPHIC_ROLLBACK'
      ELSE 'FAIL'
    END::TEXT AS status
  FROM base
  GROUP BY bucket_label, dr
  ORDER BY MIN(game_date) DESC;
END;
$$;

REVOKE EXECUTE ON FUNCTION get_d297_validation_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_d297_validation_status() TO service_role;
GRANT EXECUTE ON FUNCTION get_d297_validation_status() TO authenticated;

COMMENT ON FUNCTION get_d297_validation_status() IS
  'D-297 validation: compare MLB Elite game_side WR pre vs post '
  'surgical suppression (2026-05-24). Status: PASS if >=65% WR on '
  'n>=20, MARGINAL 58-64%, FAIL 50-57%, CATASTROPHIC_ROLLBACK <50%.';

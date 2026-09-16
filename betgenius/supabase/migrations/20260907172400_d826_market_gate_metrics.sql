-- D-826 Phase 2 — Market-level aggregate metrics view for market_gate.
--
-- Produces one row per (mlb_market_type, pick_side) with the gate-ready
-- metrics: ROI lower bound (bootstrap-approximated via Wilson), Brier score,
-- average CLV, sample size, and grading completeness.
--
-- This is a materialized summary across ALL historical picks for a given
-- market — NOT the per-event point-in-time view (v_market_training_features).
-- The market_gate runs once per market per cron cycle, so we only need
-- current aggregates, not per-event history.
--
-- Rollback: DROP VIEW IF EXISTS v_market_gate_metrics;

CREATE OR REPLACE VIEW v_market_gate_metrics AS
WITH market_stats AS (
    SELECT
        mlb_market_type AS market_type,
        pick_side,
        -- Sample counts
        COUNT(*) FILTER (WHERE hit IS NOT NULL) AS graded_picks,
        COUNT(*) AS total_picks,
        COUNT(*) FILTER (WHERE hit = true) AS wins,
        COUNT(*) FILTER (WHERE hit = false) AS losses,

        -- ROI: unit profit per pick, averaged.
        -- American odds: positive odds => profit = odds/100, negative => profit = 100/abs(odds)
        -- Unit profit on a win = (CASE WHEN odds > 0 THEN odds/100.0 ELSE 100.0/ABS(odds) END)
        -- Unit profit on a loss = -1.0
        AVG(
            CASE
                WHEN hit = true AND odds > 0 THEN odds / 100.0
                WHEN hit = true AND odds < 0 THEN 100.0 / ABS(odds)
                WHEN hit = false THEN -1.0
                ELSE NULL
            END
        ) AS avg_roi,

        -- Brier score: mean squared error of (confidence/100 - outcome)^2
        -- Lower is better. Baseline (coin flip) = 0.25.
        AVG(
            CASE WHEN hit IS NOT NULL THEN
                POWER(confidence / 100.0 - (CASE WHEN hit THEN 1.0 ELSE 0.0 END), 2)
            ELSE NULL END
        ) AS brier_score,

        -- CLV: average closing line value (already stored as percentage points)
        AVG(clv_pct) FILTER (WHERE clv_pct IS NOT NULL) AS avg_clv_pct,

        -- Confidence variance for the dynamic scoring wrapper
        STDDEV(confidence) AS confidence_variance,

        -- Average closing decimal odds (for reference)
        AVG(
            CASE
                WHEN odds > 0 THEN 1.0 + odds / 100.0
                WHEN odds < 0 THEN 1.0 + 100.0 / ABS(odds)
                ELSE NULL
            END
        ) FILTER (WHERE hit IS NOT NULL) AS avg_closing_line

    FROM pick_history
    WHERE sport = 'mlb'
      AND is_synthetic = false
      AND mlb_market_type IS NOT NULL
    GROUP BY mlb_market_type, pick_side
)
SELECT
    market_type,
    pick_side,
    graded_picks AS sample_size,
    -- Grading completeness: fraction of total picks that have been graded
    CASE WHEN total_picks > 0 THEN graded_picks::numeric / total_picks ELSE 0.0 END AS grading_completeness,
    -- Win rate
    CASE WHEN graded_picks > 0 THEN wins::numeric / graded_picks ELSE 0.0 END AS historical_win_rate,
    -- ROI lower bound: use Wilson lower bound on win rate as a conservative proxy.
    -- Wilson lower bound at 95% CI: (p + z²/2n - z*sqrt(p(1-p)/n + z²/4n²)) / (1 + z²/n)
    -- where z = 1.96 for 95% CI
    CASE WHEN graded_picks >= 20 THEN
        avg_roi - 1.96 * (
            CASE WHEN graded_picks > 1 THEN
                SQRT(
                    -- Variance of unit profit: Var(X) ≈ E[X²] - E[X]²
                    -- Approximate using win/loss proportion and payout sizes
                    GREATEST(0.01, (wins::numeric / graded_picks) * (1.0 - wins::numeric / graded_picks))
                    / graded_picks
                )
            ELSE 1.0 END
        )
    ELSE -1.0 END AS roi_lower_bound,  -- insufficient data => force gate failure
    COALESCE(avg_roi, 0.0) AS avg_roi,
    COALESCE(brier_score, 1.0) AS brier_score,
    0.25 AS baseline_brier_score,  -- coin-flip baseline
    COALESCE(avg_clv_pct / 100.0, 0.0) AS avg_clv,  -- convert pct points to decimal
    COALESCE(confidence_variance, 0.0) AS confidence_variance,
    COALESCE(avg_closing_line, 0.0) AS avg_closing_line
FROM market_stats;

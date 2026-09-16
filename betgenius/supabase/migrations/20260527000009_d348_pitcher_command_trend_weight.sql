-- D-348 — add weight column for pitcher_command_trend factor.
--
-- New factor: pitcher's recent command vs season (L3-start BB/9 vs season BB/9).
-- Higher recent walks → command DOWN → fewer Ks. Lower recent walks → +K signal.
-- Bucket ±3 max; weight 0.5 makes Math.round(±3 * 0.5) = ±2 typical contribution.
--
-- pitcher_velocity ESCALATED to D-349 (separate batch needed for Statcast ETL extension).
-- See docs/loop/architecture/d348_data_sources.md for the escalation rationale.
--
-- Rollback: ALTER TABLE algorithm_weights DROP COLUMN w_mlb_pitcher_command_trend;

ALTER TABLE public.algorithm_weights
  ADD COLUMN IF NOT EXISTS w_mlb_pitcher_command_trend NUMERIC NOT NULL DEFAULT 0.5;

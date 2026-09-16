-- D-289 PHASE 1 (2026-05-22) — backtest run history.
--
-- One row per backtest invocation. Captures the factor set, train/
-- validate windows, weights used, full results JSON, and CTO
-- recommendation. Enables A/B comparison of weight tunings + audit
-- trail of what algorithm version produced which validate WR.
--
-- Rollback:
--   DROP TABLE IF EXISTS public.historical_backtest_runs CASCADE;

CREATE TABLE IF NOT EXISTS public.historical_backtest_runs (
  run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  factor_set_version TEXT NOT NULL,
  train_window_start DATE,
  train_window_end DATE,
  validate_window_start DATE,
  validate_window_end DATE,
  weights_used JSONB,
  -- results_json schema: { per_market: {hits: {n, wr, ci_low, ci_high}, ...},
  --                       per_tier: {elite: {n, wr, ci_low, ci_high}, ...},
  --                       projection_mae: {hits: 0.42, ...} }
  results_json JSONB,
  cto_recommendation TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_backtest_runs_date ON public.historical_backtest_runs (run_date DESC);
CREATE INDEX IF NOT EXISTS idx_backtest_runs_version ON public.historical_backtest_runs (factor_set_version, run_date DESC);

ALTER TABLE public.historical_backtest_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS backtest_runs_service_all ON public.historical_backtest_runs;
CREATE POLICY backtest_runs_service_all ON public.historical_backtest_runs
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS backtest_runs_auth_read ON public.historical_backtest_runs;
CREATE POLICY backtest_runs_auth_read ON public.historical_backtest_runs
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.historical_backtest_runs IS
  'D-289: audit log of all historical-data backtest runs. Records '
  'factor set + weights + train/validate windows + results JSON + '
  'CTO recommendation. Enables A/B comparison across weight tunings.';

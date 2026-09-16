-- optimize_weights_synthetic_run hits PostgREST default statement_timeout
-- (8s) because 46 candidate backtests × scan of 12k synthetic picks needs
-- ~30-60s in total. Per-function statement_timeout override extends the
-- ceiling for this specific function only — other PostgREST queries keep
-- their fast 8s timeout.
--
-- Also setting timeout on the synthetic backtest function so individual
-- inner calls don't get clipped if they're slow.

ALTER FUNCTION optimize_weights_synthetic_run(NUMERIC, NUMERIC, NUMERIC)
  SET statement_timeout = '300s';

ALTER FUNCTION apply_optimized_weights_with_gate_synthetic(JSONB, NUMERIC, TEXT)
  SET statement_timeout = '300s';

ALTER FUNCTION backtest_weights_v3_synthetic(
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC
) SET statement_timeout = '60s';

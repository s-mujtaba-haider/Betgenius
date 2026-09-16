-- write_calibration_snapshot(snapshot_date) — runs compute for all 3 window
-- types and inserts results into calibration_snapshots. SECURITY DEFINER so
-- the edge function can invoke without elevated grant on the table.

CREATE OR REPLACE FUNCTION public.write_calibration_snapshot(
  p_snapshot_date DATE DEFAULT CURRENT_DATE
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rows_inserted INTEGER := 0;
  v_loop_inserted INTEGER;
  v_window TEXT;
  v_window_start DATE;
BEGIN
  FOR v_window IN (
    SELECT unnest(ARRAY['rolling_7d','rolling_30d','all_time'])
  )
  LOOP
    v_window_start := CASE v_window
      WHEN 'rolling_7d'  THEN p_snapshot_date - 7
      WHEN 'rolling_30d' THEN p_snapshot_date - 30
      ELSE '2026-01-01'::DATE
    END;

    INSERT INTO public.calibration_snapshots (
      snapshot_date, window_start, window_end, window_type,
      metric_type, metric_key, bets_count, bets_resolved, bets_hit,
      hit_rate, avg_confidence, backtest_hit_rate, calibration_delta,
      sample_size_warning
    )
    SELECT
      p_snapshot_date,
      v_window_start,
      p_snapshot_date,
      v_window,
      c.metric_type,
      c.metric_key,
      c.bets_count,
      c.bets_resolved,
      c.bets_hit,
      c.hit_rate,
      c.avg_confidence,
      c.backtest_hit_rate,
      c.calibration_delta,
      (c.bets_resolved < 30)::BOOLEAN
    FROM public.compute_calibration_snapshot(v_window, p_snapshot_date) c;

    GET DIAGNOSTICS v_loop_inserted = ROW_COUNT;
    v_rows_inserted := v_rows_inserted + v_loop_inserted;
  END LOOP;

  RETURN v_rows_inserted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.write_calibration_snapshot(DATE)
  TO service_role, authenticated;

COMMENT ON FUNCTION public.write_calibration_snapshot(DATE) IS
  'Writes one daily snapshot across all 3 window_types (rolling_7d / '
  'rolling_30d / all_time). Idempotent in the sense that re-running on the '
  'same snapshot_date just appends additional rows — read latest per '
  '(window_type, metric_type, metric_key, snapshot_date DESC). Returns total '
  'rows inserted.';

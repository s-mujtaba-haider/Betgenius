-- Bootstrap calibration_snapshots with May 7-11 historical data.
-- This counts as §1.12 production cycle observation for the SQL functions —
-- the edge function path verification happens tomorrow at 11:15 UTC cron.

DO $$
DECLARE
  v_row RECORD;
  v_total INTEGER := 0;
  v_inserted INTEGER;
BEGIN
  -- Capture pre-state for diff
  RAISE NOTICE '=== bootstrap calibration_snapshots @ % ===', NOW();

  SELECT COUNT(*) INTO v_inserted FROM public.calibration_snapshots;
  RAISE NOTICE 'pre-bootstrap row count: %', v_inserted;

  -- Bootstrap 5 days
  v_inserted := write_calibration_snapshot('2026-05-07'::DATE);
  RAISE NOTICE 'May 7  inserted: %', v_inserted;
  v_total := v_total + v_inserted;

  v_inserted := write_calibration_snapshot('2026-05-08'::DATE);
  RAISE NOTICE 'May 8  inserted: %', v_inserted;
  v_total := v_total + v_inserted;

  v_inserted := write_calibration_snapshot('2026-05-09'::DATE);
  RAISE NOTICE 'May 9  inserted: %', v_inserted;
  v_total := v_total + v_inserted;

  v_inserted := write_calibration_snapshot('2026-05-10'::DATE);
  RAISE NOTICE 'May 10 inserted: %', v_inserted;
  v_total := v_total + v_inserted;

  v_inserted := write_calibration_snapshot('2026-05-11'::DATE);
  RAISE NOTICE 'May 11 inserted: %', v_inserted;
  v_total := v_total + v_inserted;

  RAISE NOTICE '';
  RAISE NOTICE 'BOOTSTRAP TOTAL: % rows inserted', v_total;

  -- Verification per CEO TASK 5: counts by window+metric
  RAISE NOTICE '';
  RAISE NOTICE '=== verification: counts by (window_type, metric_type) ===';
  FOR v_row IN
    SELECT window_type, metric_type, COUNT(*) AS n
    FROM public.calibration_snapshots
    WHERE snapshot_date >= '2026-05-07'
    GROUP BY window_type, metric_type
    ORDER BY window_type, metric_type
  LOOP
    RAISE NOTICE '  window=% metric=% rows=%',
      v_row.window_type, v_row.metric_type, v_row.n;
  END LOOP;

  -- Sample-check a tier breakdown manually per CEO TASK 6.1
  RAISE NOTICE '';
  RAISE NOTICE '=== sample: today all_time tier breakdown ===';
  FOR v_row IN
    SELECT metric_key, bets_count, bets_resolved, bets_hit,
           hit_rate, avg_confidence, backtest_hit_rate, calibration_delta,
           sample_size_warning
    FROM public.calibration_snapshots
    WHERE snapshot_date = CURRENT_DATE
      AND window_type = 'all_time'
      AND metric_type = 'tier'
    ORDER BY metric_key DESC
  LOOP
    RAISE NOTICE '  tier=% count=% resolved=% hit=% hit_rate=% avg_conf=% backtest=% delta=% low_sample=%',
      v_row.metric_key, v_row.bets_count, v_row.bets_resolved, v_row.bets_hit,
      v_row.hit_rate, v_row.avg_confidence, v_row.backtest_hit_rate,
      v_row.calibration_delta, v_row.sample_size_warning;
  END LOOP;

  -- Overall snapshot today across all windows
  RAISE NOTICE '';
  RAISE NOTICE '=== sample: today overall metric across windows ===';
  FOR v_row IN
    SELECT window_type, bets_count, bets_resolved, bets_hit,
           hit_rate, avg_confidence
    FROM public.calibration_snapshots
    WHERE snapshot_date = CURRENT_DATE
      AND metric_type = 'overall'
    ORDER BY window_type
  LOOP
    RAISE NOTICE '  window=% count=% resolved=% hit=% hit_rate=% avg_conf=%',
      v_row.window_type, v_row.bets_count, v_row.bets_resolved, v_row.bets_hit,
      v_row.hit_rate, v_row.avg_confidence;
  END LOOP;
END $$;

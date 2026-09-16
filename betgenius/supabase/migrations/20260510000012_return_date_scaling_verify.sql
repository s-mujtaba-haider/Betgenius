-- Post-deploy verification (May 11 02:13 UTC). Outside cron window so
-- writer-path cycle deferred to tomorrow 14:00 UTC per §1.12. Confirms:
-- (a) no error_log spike since deploy
-- (b) skip-path cycle still landing
-- (c) historical pick_history shape for comparison after tomorrow's first
--     scoring cycle

DO $$
DECLARE
  v_row RECORD;
  v_count INTEGER;
BEGIN
  RAISE NOTICE '=== return_date scaling verify @ % ===', NOW();

  -- error_log since deploy (~02:12 UTC)
  SELECT COUNT(*) INTO v_count
  FROM error_log
  WHERE function_name IN ('process-games','analyze-pick')
    AND created_at > '2026-05-11 02:11:00+00';
  RAISE NOTICE 'error_log entries since deploy: %', v_count;

  -- run_log post-deploy
  RAISE NOTICE '';
  RAISE NOTICE '--- run_log: process-games rows since deploy ---';
  FOR v_row IN
    SELECT created_at, status, games_found, recommendations,
           ROUND(EXTRACT(EPOCH FROM (NOW() - created_at)) / 60.0, 1) AS age_min
    FROM run_log
    WHERE function_name = 'process-games'
      AND created_at > '2026-05-11 02:11:00+00'
    ORDER BY created_at DESC
  LOOP
    RAISE NOTICE '  age=% min status=% games=% recs=%',
      v_row.age_min, v_row.status, v_row.games_found, v_row.recommendations;
  END LOOP;

  -- Reference snapshot — current variety of score_player_injury values in
  -- existing pick_history (from before the scaling change shipped). After
  -- tomorrow's first cron tick lands new rows, we should see additional
  -- magnitudes appear, especially scaled values like -9 (round(-25*0.75)
  -- with w_player_injury=0.75) and -5 (round(-12*0.75 with 50% scale)).
  RAISE NOTICE '';
  RAISE NOTICE '--- pre-deploy reference: distinct score_player_injury values in last 7 days ---';
  FOR v_row IN
    SELECT score_player_injury AS spi, COUNT(*) AS rows_count
    FROM pick_history
    WHERE created_at >= NOW() - INTERVAL '7 days'
      AND score_player_injury IS NOT NULL
      AND score_player_injury <> 0
    GROUP BY score_player_injury
    ORDER BY ABS(score_player_injury) DESC, score_player_injury DESC
    LIMIT 15
  LOOP
    RAISE NOTICE '  score_player_injury=% rows=%', v_row.spi, v_row.rows_count;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'Next writer-path cycle: May 11 ~14:01 UTC (first NBA slate cron tick of the day).';
  RAISE NOTICE 'After that, re-run CEO TASK 6 query to see new magnitudes including scaled values.';
END $$;

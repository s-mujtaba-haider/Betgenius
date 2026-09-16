-- D-112 verification baseline (May 9, 2026). Captures run_log + notifications_log
-- state immediately after deploy, before next cron tick. Read-only NOTICE output.

DO $$
DECLARE
  v_row RECORD;
  v_now TIMESTAMPTZ;
  v_count_success INTEGER;
  v_count_skipped INTEGER;
  v_last_run_age_min NUMERIC;
BEGIN
  v_now := NOW();
  RAISE NOTICE '=== D-112 baseline @ % ===', v_now;

  -- Recent run_log rows for process-games
  RAISE NOTICE '';
  RAISE NOTICE '--- run_log: last 10 process-games rows ---';
  FOR v_row IN
    SELECT created_at, status, games_found, recommendations,
           ROUND(EXTRACT(EPOCH FROM (NOW() - created_at)) / 60.0, 1) AS age_min,
           LEFT(COALESCE(notes, '(no notes)'), 100) AS notes_preview
    FROM run_log
    WHERE function_name = 'process-games'
    ORDER BY created_at DESC
    LIMIT 10
  LOOP
    RAISE NOTICE '  age=% min  status=%  games=%  recs=%  notes: %',
      v_row.age_min, v_row.status, v_row.games_found, v_row.recommendations, v_row.notes_preview;
  END LOOP;

  -- Counts
  SELECT COUNT(*) INTO v_count_success
  FROM run_log WHERE function_name = 'process-games' AND status = 'success'
    AND created_at >= v_now - INTERVAL '24 hours';
  SELECT COUNT(*) INTO v_count_skipped
  FROM run_log WHERE function_name = 'process-games' AND status = 'skipped'
    AND created_at >= v_now - INTERVAL '24 hours';

  RAISE NOTICE '';
  RAISE NOTICE 'Last 24h: success=% skipped=%', v_count_success, v_count_skipped;
  RAISE NOTICE '(Expected: skipped=0 before our deploy; should grow on next 15-min cron ticks if today''s slate is fully processed.)';

  -- Health-monitor's exact query (post-D-112 filter)
  RAISE NOTICE '';
  RAISE NOTICE '--- health-monitor view (post-D-112 filter status=in.(success,skipped)) ---';
  SELECT ROUND(EXTRACT(EPOCH FROM (v_now - r.created_at)) / 60.0, 1) INTO v_last_run_age_min
  FROM run_log r
  WHERE r.function_name = 'process-games'
    AND r.status IN ('success', 'skipped')
  ORDER BY r.created_at DESC
  LIMIT 1;
  RAISE NOTICE 'Last success-or-skipped row: % min ago (threshold 30; pass = <=30)', COALESCE(v_last_run_age_min::TEXT, 'NONE');

  -- Pre-D-112 query for comparison (still status=eq.success)
  RAISE NOTICE '';
  RAISE NOTICE '--- pre-D-112 query (status=eq.success only) ---';
  SELECT ROUND(EXTRACT(EPOCH FROM (v_now - r.created_at)) / 60.0, 1) INTO v_last_run_age_min
  FROM run_log r
  WHERE r.function_name = 'process-games'
    AND r.status = 'success'
  ORDER BY r.created_at DESC
  LIMIT 1;
  RAISE NOTICE 'Last success-only row: % min ago (would be the false-alarm trigger if >30)', COALESCE(v_last_run_age_min::TEXT, 'NONE');

  -- Recent process-games-related notifications
  RAISE NOTICE '';
  RAISE NOTICE '--- notifications_log: last 5 process-games-related rows ---';
  FOR v_row IN
    SELECT created_at, severity, title, LEFT(COALESCE(message, ''), 80) AS msg_preview, delivered_via
    FROM notifications_log
    WHERE title ILIKE '%process-games%' OR title ILIKE '%cron silent%'
    ORDER BY created_at DESC
    LIMIT 5
  LOOP
    RAISE NOTICE '  [%] sev=% via=% — % | %',
      v_row.created_at, v_row.severity, v_row.delivered_via, v_row.title, v_row.msg_preview;
  END LOOP;

  -- Cron jobid 9 + 10 schedule sanity
  RAISE NOTICE '';
  RAISE NOTICE '--- cron jobs 9 (process-games) + 10 (health-monitor) ---';
  FOR v_row IN
    SELECT jobid, jobname, schedule, active
    FROM cron.job
    WHERE jobid IN (9, 10)
    ORDER BY jobid
  LOOP
    RAISE NOTICE '  jobid=% name=% schedule=% active=%',
      v_row.jobid, v_row.jobname, v_row.schedule, v_row.active;
  END LOOP;
END $$;

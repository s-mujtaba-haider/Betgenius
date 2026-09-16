-- D-112 verification after 14:30 UTC cron ticks (May 9, 2026).
-- 14:00 + 14:15 already processed both games on today's slate.
-- 14:30 tick should hit "all games already complete" skip path → first 'skipped' row.
-- 14:30 health-monitor tick should see fresh data via the relaxed filter.
-- Read-only NOTICE.

DO $$
DECLARE
  v_row RECORD;
  v_now TIMESTAMPTZ;
  v_count_success_today INTEGER;
  v_count_skipped_today INTEGER;
  v_last_run_age_min NUMERIC;
  v_alerts_after_deploy INTEGER;
BEGIN
  v_now := NOW();
  RAISE NOTICE '=== D-112 post-14:30-tick verify @ % ===', v_now;

  RAISE NOTICE '';
  RAISE NOTICE '--- run_log: process-games rows in last 35 min ---';
  FOR v_row IN
    SELECT created_at, status, games_found, recommendations,
           ROUND(EXTRACT(EPOCH FROM (NOW() - created_at)) / 60.0, 1) AS age_min,
           LEFT(COALESCE(notes, '(no notes)'), 200) AS notes_preview
    FROM run_log
    WHERE function_name = 'process-games'
      AND created_at >= v_now - INTERVAL '35 minutes'
    ORDER BY created_at DESC
  LOOP
    RAISE NOTICE '  age=% min  status=%  games=%  recs=%  notes: %',
      v_row.age_min, v_row.status, v_row.games_found, v_row.recommendations, v_row.notes_preview;
  END LOOP;

  SELECT COUNT(*) INTO v_count_success_today
  FROM run_log
  WHERE function_name = 'process-games' AND status = 'success'
    AND created_at >= DATE_TRUNC('day', NOW());
  SELECT COUNT(*) INTO v_count_skipped_today
  FROM run_log
  WHERE function_name = 'process-games' AND status = 'skipped'
    AND created_at >= DATE_TRUNC('day', NOW());

  RAISE NOTICE '';
  RAISE NOTICE 'Today (UTC): success=% skipped=%', v_count_success_today, v_count_skipped_today;
  RAISE NOTICE '(Expected: skipped >= 1 if 14:30 tick fired against already-processed slate.)';

  SELECT ROUND(EXTRACT(EPOCH FROM (v_now - r.created_at)) / 60.0, 1) INTO v_last_run_age_min
  FROM run_log r
  WHERE r.function_name = 'process-games'
    AND r.status IN ('success', 'skipped')
  ORDER BY r.created_at DESC
  LIMIT 1;
  RAISE NOTICE '';
  RAISE NOTICE 'health-monitor (post-D-112) last success-or-skipped: % min ago (threshold 30; pass if <=30)', COALESCE(v_last_run_age_min::TEXT, 'NONE');

  SELECT COUNT(*) INTO v_alerts_after_deploy
  FROM notifications_log
  WHERE created_at >= '2026-05-09 14:12:00+00'
    AND title ILIKE '%cron silent%'
    AND severity = 'critical';
  RAISE NOTICE '';
  RAISE NOTICE 'Critical "cron silent" alerts since deploy (14:12 UTC): %', v_alerts_after_deploy;
  RAISE NOTICE '(Expected: 0)';

  IF v_alerts_after_deploy > 0 THEN
    FOR v_row IN
      SELECT created_at, title, LEFT(COALESCE(message, ''), 100) AS msg_preview
      FROM notifications_log
      WHERE created_at >= '2026-05-09 14:12:00+00'
        AND title ILIKE '%cron silent%' AND severity = 'critical'
      ORDER BY created_at DESC
    LOOP
      RAISE NOTICE '  ALERT [%] — % | %', v_row.created_at, v_row.title, v_row.msg_preview;
    END LOOP;
  END IF;

  -- Did health-monitor itself fire at 14:30 UTC? Look for any healthy-status notification or run_log row from health-monitor.
  RAISE NOTICE '';
  RAISE NOTICE '--- health-monitor: any rows in run_log in last 5 min? (jobid 10 fires every 30 min) ---';
  FOR v_row IN
    SELECT created_at, status, ROUND(EXTRACT(EPOCH FROM (NOW() - created_at)) / 60.0, 1) AS age_min
    FROM run_log
    WHERE function_name = 'health-monitor'
      AND created_at >= v_now - INTERVAL '10 minutes'
    ORDER BY created_at DESC
  LOOP
    RAISE NOTICE '  age=% min  status=%', v_row.age_min, v_row.status;
  END LOOP;
END $$;

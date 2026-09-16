DO $$
DECLARE v_pending BIGINT; v_resolved_total BIGINT; v_jobs JSONB;
        v_elapsed NUMERIC; v_rate NUMERIC;
BEGIN
  SELECT count(*) INTO v_pending FROM public.pick_history
   WHERE hit IS NULL AND resolved_at IS NULL AND voided <> true
     AND is_synthetic = false AND game_date >= DATE '2026-05-28';
  SELECT count(*) INTO v_resolved_total FROM public.pick_history
   WHERE resolved_at >= '2026-06-11 02:11:00+00';
  v_elapsed := EXTRACT(EPOCH FROM (NOW() - '2026-06-11 02:11:00+00'::TIMESTAMPTZ)) / 60.0;
  v_rate := CASE WHEN v_elapsed > 0 THEN v_resolved_total / v_elapsed ELSE 0 END;

  RAISE NOTICE '[D-506 progress2] pending=% resolved=% elapsed_min=% rate=%/min ETA_min=%',
    v_pending, v_resolved_total, ROUND(v_elapsed, 1), ROUND(v_rate, 1),
    CASE WHEN v_rate > 0 THEN ROUND(v_pending / v_rate, 1)::text ELSE 'n/a' END;

  -- Backfill cron health
  DECLARE r RECORD;
  BEGIN
    RAISE NOTICE '[D-506 progress2] cron 44 last 5 runs:';
    FOR r IN
      SELECT start_time, status, length(COALESCE(return_message,'')) AS rmsglen
      FROM cron.job_run_details
      WHERE jobid = 44 ORDER BY start_time DESC LIMIT 5
    LOOP
      RAISE NOTICE '  start=% status=% rmsg_len=%', r.start_time, r.status, r.rmsglen;
    END LOOP;
  END;
END $$;

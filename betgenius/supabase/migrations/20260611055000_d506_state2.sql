DO $$
DECLARE v_pending BIGINT; v_resolved BIGINT; r RECORD;
        v_max_real DATE; v_real_total BIGINT;
BEGIN
  SELECT count(*) INTO v_pending FROM public.pick_history
   WHERE hit IS NULL AND resolved_at IS NULL AND voided <> true
     AND is_synthetic = false AND game_date >= DATE '2026-05-28';
  SELECT count(*) INTO v_resolved FROM public.pick_history
   WHERE resolved_at >= '2026-06-11 02:11:00+00';
  SELECT count(*), max(game_date) INTO v_real_total, v_max_real
    FROM public.pick_history_real WHERE is_synthetic = false;

  RAISE NOTICE '[D-506 state2] pending=% resolved_since_2:11=% real_total=% real_max=%',
    v_pending, v_resolved, v_real_total, v_max_real;

  RAISE NOTICE '[D-506 state2] resolve crons (active):';
  FOR r IN SELECT jobid, jobname, schedule, active FROM cron.job
    WHERE jobname ILIKE '%resolve%' ORDER BY jobid
  LOOP RAISE NOTICE '  jobid=% name=% sched=% active=%', r.jobid, r.jobname, r.schedule, r.active; END LOOP;

  RAISE NOTICE '[D-506 state2] cron 45 last 5 runs:';
  FOR r IN SELECT start_time, status FROM cron.job_run_details
   WHERE jobid = 45 ORDER BY start_time DESC LIMIT 5
  LOOP RAISE NOTICE '  start=% status=%', r.start_time, r.status; END LOOP;
END $$;

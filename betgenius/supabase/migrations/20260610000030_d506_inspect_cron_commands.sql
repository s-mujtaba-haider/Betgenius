DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-506] resolve-picks cron commands:';
  FOR r IN SELECT jobid, jobname, schedule, substring(command, 1, 600) AS cmd
   FROM cron.job WHERE jobid IN (1,2,3) ORDER BY jobid
  LOOP
    RAISE NOTICE 'jobid=% jobname=% schedule=%', r.jobid, r.jobname, r.schedule;
    RAISE NOTICE '  cmd=%', r.cmd;
  END LOOP;

  -- Total pending non-synthetic since 2026-05-30
  DECLARE v_total BIGINT; v_mlb BIGINT; v_nba BIGINT;
  BEGIN
    SELECT count(*) INTO v_total FROM public.pick_history
     WHERE hit IS NULL AND resolved_at IS NULL AND voided IS DISTINCT FROM true
       AND is_synthetic = false AND game_date >= DATE '2026-05-30';
    SELECT count(*) INTO v_mlb FROM public.pick_history
     WHERE hit IS NULL AND resolved_at IS NULL AND voided IS DISTINCT FROM true
       AND is_synthetic = false AND game_date >= DATE '2026-05-30' AND sport='mlb';
    SELECT count(*) INTO v_nba FROM public.pick_history
     WHERE hit IS NULL AND resolved_at IS NULL AND voided IS DISTINCT FROM true
       AND is_synthetic = false AND game_date >= DATE '2026-05-30' AND sport='nba';
    RAISE NOTICE '[D-506] pending non-syn since 2026-05-30: total=% mlb=% nba=%', v_total, v_mlb, v_nba;
  END;

  -- Look at recent cron.job_run_details with full return_message
  RAISE NOTICE '[D-506] recent resolve-picks runs (last 5, full return_message):';
  FOR r IN
    SELECT jobid, start_time, status, return_message
    FROM cron.job_run_details
    WHERE jobid IN (1,2,3) AND start_time >= NOW() - INTERVAL '5 days'
    ORDER BY start_time DESC LIMIT 5
  LOOP
    RAISE NOTICE '  jobid=% at=% status=% msg=%', r.jobid, r.start_time, r.status, COALESCE(r.return_message, '<null>');
  END LOOP;
END $$;

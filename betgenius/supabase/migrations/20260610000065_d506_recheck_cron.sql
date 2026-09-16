DO $$
DECLARE r RECORD; v_pending BIGINT;
BEGIN
  SELECT count(*) INTO v_pending FROM public.pick_history
   WHERE hit IS NULL AND resolved_at IS NULL AND voided <> true
     AND is_synthetic = false AND game_date >= DATE '2026-05-28';
  RAISE NOTICE '[D-506] pending=%', v_pending;

  RAISE NOTICE '[D-506] all resolve-picks-related cron jobs (active or not):';
  FOR r IN SELECT jobid, jobname, schedule, active FROM cron.job
    WHERE jobname ILIKE '%resolve%' OR jobname ILIKE '%d506%' OR jobname ILIKE '%backfill%'
    ORDER BY jobid
  LOOP RAISE NOTICE '  jobid=% name=% sched=% active=%', r.jobid, r.jobname, r.schedule, r.active; END LOOP;
END $$;

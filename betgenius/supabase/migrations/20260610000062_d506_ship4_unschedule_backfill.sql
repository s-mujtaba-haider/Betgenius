-- D-506 SHIP 3c / SHIP 4 — unschedule the backfill cron after queue drain.
-- The temporary every-minute cron scheduled in 20260610000050 has finished
-- its job; regular crons (jobid 1, 2, 3) handle ongoing resolution.
SELECT cron.unschedule('resolve-picks-d506-backfill');

DO $$
DECLARE r RECORD; v_remaining BIGINT;
BEGIN
  SELECT count(*) INTO v_remaining FROM public.pick_history
   WHERE hit IS NULL AND resolved_at IS NULL AND voided <> true
     AND is_synthetic = false AND game_date >= DATE '2026-05-28';
  RAISE NOTICE '[D-506 SHIP 4] backfill cron unscheduled. final pending=%', v_remaining;

  -- Active cron jobs sanity
  RAISE NOTICE '[D-506 SHIP 4] active resolve-picks cron jobs:';
  FOR r IN SELECT jobid, jobname, schedule, active FROM cron.job
            WHERE jobname ILIKE '%resolve%' ORDER BY jobid
  LOOP
    RAISE NOTICE '  jobid=% name=% sched=% active=%', r.jobid, r.jobname, r.schedule, r.active;
  END LOOP;
END $$;

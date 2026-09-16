-- D-506 post-drain — unschedule the backfill cron once the queue is drained.
-- Run AFTER pending pick count is below 200 (regular crons handle the tail).
SELECT cron.unschedule('resolve-picks-d506-backfill');

DO $$
DECLARE r RECORD; v_pending BIGINT;
BEGIN
  SELECT count(*) INTO v_pending FROM public.pick_history
   WHERE hit IS NULL AND resolved_at IS NULL AND voided <> true
     AND is_synthetic = false AND game_date >= DATE '2026-05-28';
  RAISE NOTICE '[D-506 post-drain] backfill cron unscheduled. final pending=%', v_pending;

  RAISE NOTICE '[D-506 post-drain] active resolve-picks crons:';
  FOR r IN SELECT jobid, jobname, schedule, active FROM cron.job
    WHERE jobname ILIKE '%resolve%' ORDER BY jobid
  LOOP RAISE NOTICE '  jobid=% name=% sched=% active=%', r.jobid, r.jobname, r.schedule, r.active; END LOOP;
END $$;

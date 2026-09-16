-- D-514 SHIP 2 — two fixes:
-- (a) Drop the V1 overload of capture_closing_odds_mlb that's making the
--     cron call ambiguous (D-511 SHIP 3 left both V1 + V2 deployed).
-- (b) Extend jobid 21 + 46 cron windows to cover the full 24h, closing the
--     12.5h stale-morning dead-zone. Props arrive at 04:00 UTC (= midnight
--     ET) every day per 7-day props_cache data; scoring should run from
--     then onward, not wait for the 17:00 UTC window restart.
--
-- Rollback:
--   (a) recreate the V1 overload from 20260611100200_d511_capture_fn.sql
--   (b) UPDATE cron.job SET schedule='*/5 17-23,0-4 * * *' WHERE jobname IN
--         ('process-games-mlb-30min', 'capture-closing-odds-mlb-5min');

-- (a) drop the V1 overload (single-arg). V2 (two-arg, both with defaults)
--     covers the zero-arg cron call path on its own.
DROP FUNCTION IF EXISTS public.capture_closing_odds_mlb(INTEGER);

-- (b) widen the cron windows to */5 * * * * (every 5 min, all day).
SELECT cron.alter_job(
  job_id := (SELECT jobid FROM cron.job WHERE jobname = 'process-games-mlb-30min'),
  schedule := '*/5 * * * *'
);
SELECT cron.alter_job(
  job_id := (SELECT jobid FROM cron.job WHERE jobname = 'capture-closing-odds-mlb-5min'),
  schedule := '*/5 * * * *'
);

DO $$
DECLARE r RECORD; v_n INT;
BEGIN
  -- Verify V1 dropped, V2 alone
  SELECT count(*) INTO v_n FROM pg_proc
    WHERE proname='capture_closing_odds_mlb'
      AND pronamespace=(SELECT oid FROM pg_namespace WHERE nspname='public');
  RAISE NOTICE '[D-514 SHIP 2] capture_closing_odds_mlb overloads remaining: % (expected 1)', v_n;

  RAISE NOTICE '[D-514 SHIP 2] schedule update confirmed:';
  FOR r IN SELECT jobid, jobname, schedule, active FROM cron.job
    WHERE jobname IN ('process-games-mlb-30min', 'capture-closing-odds-mlb-5min')
    ORDER BY jobid
  LOOP RAISE NOTICE '  jobid=% name=% sched=% active=%',
    r.jobid, r.jobname, r.schedule, r.active; END LOOP;
END $$;

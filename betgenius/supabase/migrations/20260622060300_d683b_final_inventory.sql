-- D-683b SHIP 3 — post-restore inventory of cron.job state.
-- Critical: confirm essential restores landed, heavy non-essentials stay paused.
DO $$
DECLARE r RECORD; v_active INT; BEGIN
  SELECT COUNT(*) INTO v_active FROM cron.job;
  RAISE NOTICE 'D-683b cron.job active count=%', v_active;
  RAISE NOTICE '── ACTIVE jobs (subset relevant to D-683b):';
  FOR r IN
    SELECT jobname, schedule FROM cron.job
    WHERE jobname IN (
      'resolve-picks-daily','resolve-picks-nightly',
      'lineup-confirmation-watcher-10min','fetch-mlb-boxscores-daily',
      'refresh-mlb-scoreboard-status-daily','process-games-mlb-30min',
      'fetch-odds-mlb-30min','capture-closing-odds-mlb-5min',
      'snapshot-odds-writer-30min','fetch-mlb-team-oaa-daily',
      'system-health-hourly','health-monitor'
    )
    ORDER BY jobname
  LOOP
    RAISE NOTICE 'ACTIVE: % schedule=%', r.jobname, r.schedule;
  END LOOP;
  RAISE NOTICE '── STILL PAUSED jobs (intentionally; D-681+D-683b SHIP 2):';
  FOR r IN
    SELECT jobname FROM public._d681_cron_pause_log
    WHERE action = 'unscheduled'
      AND jobname NOT IN (
        SELECT jobname FROM cron.job
      )
    ORDER BY jobname
  LOOP
    RAISE NOTICE 'PAUSED: %', r.jobname;
  END LOOP;
END $$;

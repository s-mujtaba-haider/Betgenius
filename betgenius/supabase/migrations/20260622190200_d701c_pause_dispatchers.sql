-- D-701c SHIP 4 — pause ONLY monitoring + non-live-path heavy crons.
-- KEEP active per user directive: scoring, odds, resolver, schedule-register, dispatcher.
-- Pause: monitors + orchestrator (NOT in critical-live list).

CREATE TABLE IF NOT EXISTS public._d701c_cron_pause_log (
  paused_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  action TEXT, jobname TEXT, schedule TEXT, command TEXT, reason TEXT
);

-- Snapshot the crons we'll touch (idempotent — only adds rows for the listed jobs)
INSERT INTO public._d701c_cron_pause_log(action, jobname, schedule, command, reason)
SELECT 'snapshot', jobname, schedule, command, 'pre-D-701c snapshot'
FROM cron.job
WHERE jobname IN (
  'd609-system-health-hourly',
  'health-monitor',
  'sonnet-health-monitor-hourly',
  'dashboard-health-check-2h',
  'orchestrator-execute',
  'orchestrator-daily-report'
);

DO $$
DECLARE
  v_paused TEXT[] := ARRAY[
    'd609-system-health-hourly',
    'health-monitor',
    'sonnet-health-monitor-hourly',
    'dashboard-health-check-2h',
    'orchestrator-execute',
    'orchestrator-daily-report'
  ];
  v_name TEXT;
  v_paused_count int := 0;
  rec record;
BEGIN
  FOREACH v_name IN ARRAY v_paused LOOP
    IF EXISTS(SELECT 1 FROM cron.job WHERE jobname = v_name) THEN
      PERFORM cron.unschedule(v_name);
      INSERT INTO public._d701c_cron_pause_log(action, jobname, reason)
      VALUES ('unscheduled', v_name, 'D-701c PGRST002 recovery — monitoring + orchestrator non-critical');
      v_paused_count := v_paused_count + 1;
      RAISE NOTICE 'D-701c paused %', v_name;
    END IF;
  END LOOP;
  RAISE NOTICE 'D-701c paused % crons (monitoring + orchestrator only — live path untouched)', v_paused_count;

  RAISE NOTICE '=== ACTIVE crons after D-701c pause ===';
  FOR rec IN SELECT jobid, jobname, schedule FROM cron.job WHERE active ORDER BY jobname LOOP
    RAISE NOTICE '  jobid=% % schedule=%', rec.jobid, rec.jobname, rec.schedule;
  END LOOP;

  -- Reload PostgREST schema cache now that load is lower
  PERFORM pg_notify('pgrst', 'reload schema');
  RAISE NOTICE 'pg_notify reload dispatched';

  -- Status check
  DECLARE n int; n5 int;
  BEGIN
    SELECT count(*) INTO n FROM pg_stat_activity;
    SELECT count(*) INTO n5 FROM pg_stat_activity WHERE state='active';
    RAISE NOTICE 'pg_stat_activity: total=% active=%', n, n5;

    SELECT count(*) INTO n FROM net._http_response WHERE created > NOW() - INTERVAL '5 minutes';
    RAISE NOTICE 'pg_net last 5min: %', n;
  END;
END $$;

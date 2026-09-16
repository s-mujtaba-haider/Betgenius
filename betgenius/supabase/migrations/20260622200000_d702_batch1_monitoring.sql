-- D-702 BATCH 1 — restore 6 monitoring + orchestrator crons from D-701c pause.
-- These were paused 1.5h ago for PGRST002 recovery. Site is back, restoring.

CREATE TABLE IF NOT EXISTS public._d702_restore_log (
  restored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  jobname TEXT, jobid BIGINT, schedule TEXT, source TEXT, ok BOOLEAN, err TEXT
);

DO $$
DECLARE
  v_batch TEXT[] := ARRAY[
    'd609-system-health-hourly',
    'health-monitor',
    'sonnet-health-monitor-hourly',
    'dashboard-health-check-2h',
    'orchestrator-execute',
    'orchestrator-daily-report'
  ];
  v_name TEXT;
  v_schedule TEXT;
  v_command TEXT;
  v_already_on BOOLEAN;
  v_jobid BIGINT;
BEGIN
  FOREACH v_name IN ARRAY v_batch LOOP
    -- Skip if already scheduled
    SELECT EXISTS(SELECT 1 FROM cron.job WHERE jobname = v_name) INTO v_already_on;
    IF v_already_on THEN
      INSERT INTO public._d702_restore_log(jobname, source, ok, err)
      VALUES (v_name, 'D-701c', true, 'already scheduled — skip');
      RAISE NOTICE 'D-702 % already scheduled', v_name;
      CONTINUE;
    END IF;

    -- Pull snapshot from _d701c_cron_pause_log
    SELECT schedule, command INTO v_schedule, v_command
    FROM public._d701c_cron_pause_log
    WHERE jobname = v_name AND action='snapshot'
    ORDER BY paused_at DESC LIMIT 1;

    IF v_schedule IS NULL THEN
      INSERT INTO public._d702_restore_log(jobname, source, ok, err)
      VALUES (v_name, 'D-701c', false, 'no snapshot found');
      RAISE NOTICE 'D-702 NO snapshot for %', v_name;
      CONTINUE;
    END IF;

    -- Schedule
    BEGIN
      PERFORM cron.schedule(v_name, v_schedule, v_command);
      SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = v_name;
      INSERT INTO public._d702_restore_log(jobname, jobid, schedule, source, ok)
      VALUES (v_name, v_jobid, v_schedule, 'D-701c', true);
      RAISE NOTICE 'D-702 restored % jobid=% schedule=%', v_name, v_jobid, v_schedule;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public._d702_restore_log(jobname, source, ok, err)
      VALUES (v_name, 'D-701c', false, SQLERRM);
      RAISE NOTICE 'D-702 FAILED % err=%', v_name, SQLERRM;
    END;
  END LOOP;
END $$;

-- Post-batch health
DO $$
DECLARE rec record; v_tot int; v_act int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE state='active') INTO v_tot, v_act FROM pg_stat_activity;
  RAISE NOTICE 'post-batch1 pg_stat_activity: total=% active=%', v_tot, v_act;

  -- Long queries
  FOR rec IN
    SELECT pid, state, EXTRACT(EPOCH FROM (NOW() - query_start))::int AS sec, left(query,80) AS q
    FROM pg_stat_activity WHERE state != 'idle' AND query_start IS NOT NULL AND NOW() - query_start > INTERVAL '30 seconds'
  LOOP
    RAISE NOTICE '  long pid=% state=% sec=% q=%', rec.pid, rec.state, rec.sec, rec.q;
  END LOOP;

  -- Active cron count
  SELECT count(*) INTO v_tot FROM cron.job WHERE active;
  RAISE NOTICE 'active crons: %', v_tot;
END $$;

SELECT 'D-702 batch1 done' AS done;

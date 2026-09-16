-- D-702 BATCH 3 — restore 3 weekly heavy aggregation crons from D-681 pause.

DO $$
DECLARE
  v_batch TEXT[] := ARRAY[
    'd664-weight-fit-weekly',
    'fetch-baseball-savant-weekly',
    'fetch-savant-team-chase-weekly'
  ];
  v_name TEXT;
  v_schedule TEXT;
  v_command TEXT;
  v_already_on BOOLEAN;
  v_jobid BIGINT;
BEGIN
  FOREACH v_name IN ARRAY v_batch LOOP
    SELECT EXISTS(SELECT 1 FROM cron.job WHERE jobname = v_name) INTO v_already_on;
    IF v_already_on THEN
      INSERT INTO public._d702_restore_log(jobname, source, ok, err)
      VALUES (v_name, 'D-681', true, 'already scheduled');
      CONTINUE;
    END IF;

    SELECT schedule, command INTO v_schedule, v_command
    FROM public._d681_cron_pause_log
    WHERE jobname = v_name AND action='snapshot'
    ORDER BY paused_at DESC LIMIT 1;

    IF v_schedule IS NULL THEN
      INSERT INTO public._d702_restore_log(jobname, source, ok, err)
      VALUES (v_name, 'D-681', false, 'no snapshot found');
      RAISE NOTICE 'D-702 NO snapshot for %', v_name;
      CONTINUE;
    END IF;

    BEGIN
      PERFORM cron.schedule(v_name, v_schedule, v_command);
      SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = v_name;
      INSERT INTO public._d702_restore_log(jobname, jobid, schedule, source, ok)
      VALUES (v_name, v_jobid, v_schedule, 'D-681', true);
      RAISE NOTICE 'D-702 restored % jobid=% schedule=%', v_name, v_jobid, v_schedule;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public._d702_restore_log(jobname, source, ok, err)
      VALUES (v_name, 'D-681', false, SQLERRM);
      RAISE NOTICE 'D-702 FAILED % err=%', v_name, SQLERRM;
    END;
  END LOOP;
END $$;

-- Final state
DO $$
DECLARE rec record; v_tot int; v_act int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE state='active') INTO v_tot, v_act FROM pg_stat_activity;
  RAISE NOTICE 'FINAL pg_stat_activity: total=% active=%', v_tot, v_act;

  FOR rec IN
    SELECT pid, state, EXTRACT(EPOCH FROM (NOW() - query_start))::int AS sec, left(query,80) AS q
    FROM pg_stat_activity WHERE state != 'idle' AND query_start IS NOT NULL
      AND NOW() - query_start > INTERVAL '30 seconds'
  LOOP
    RAISE NOTICE '  long pid=% sec=% q=%', rec.pid, rec.sec, rec.q;
  END LOOP;

  SELECT count(*) INTO v_tot FROM cron.job WHERE active;
  RAISE NOTICE 'FINAL active crons: %', v_tot;
END $$;

-- Echo full restore log
DO $$
DECLARE rec record;
BEGIN
  RAISE NOTICE '=== D-702 RESTORE LOG ===';
  FOR rec IN SELECT * FROM _d702_restore_log ORDER BY restored_at LOOP
    RAISE NOTICE '  [%] % jobid=% (%) %', rec.ok, rec.jobname, COALESCE(rec.jobid::text,'-'), rec.source, COALESCE(rec.err,'OK');
  END LOOP;
END $$;

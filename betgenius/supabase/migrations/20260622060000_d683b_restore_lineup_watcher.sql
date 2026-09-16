-- D-683b SHIP 1.2 — restore lineup-confirmation-watcher-10min from
-- _d681_cron_pause_log snapshot. Reads the original (schedule, command)
-- exactly so behavior matches pre-pause.
DO $$
DECLARE
  v_schedule TEXT;
  v_command TEXT;
  v_jobname TEXT := 'lineup-confirmation-watcher-10min';
BEGIN
  SELECT schedule, command INTO v_schedule, v_command
  FROM public._d681_cron_pause_log
  WHERE jobname = v_jobname AND action = 'snapshot'
  ORDER BY paused_at DESC LIMIT 1;
  IF v_schedule IS NULL THEN
    RAISE NOTICE 'D-683b NO snapshot found for %; skipping', v_jobname;
    RETURN;
  END IF;
  -- Skip if already scheduled
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = v_jobname) THEN
    RAISE NOTICE 'D-683b % already scheduled; skipping', v_jobname;
    RETURN;
  END IF;
  PERFORM cron.schedule(v_jobname, v_schedule, v_command);
  INSERT INTO public._d681_cron_pause_log(action, jobname, reason)
  VALUES ('restored', v_jobname, 'D-683b restore for today game settlement');
  RAISE NOTICE 'D-683b restored % schedule=%', v_jobname, v_schedule;
END $$;

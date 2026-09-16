-- D-683b SHIP 1.4 — restore refresh-mlb-scoreboard-status-daily from
-- _d681_cron_pause_log snapshot. Final cron needed for game-status
-- updates so the resolver knows which games finished.
DO $$
DECLARE
  v_schedule TEXT;
  v_command TEXT;
  v_jobname TEXT := 'refresh-mlb-scoreboard-status-daily';
BEGIN
  SELECT schedule, command INTO v_schedule, v_command
  FROM public._d681_cron_pause_log
  WHERE jobname = v_jobname AND action = 'snapshot'
  ORDER BY paused_at DESC LIMIT 1;
  IF v_schedule IS NULL THEN
    RAISE NOTICE 'D-683b NO snapshot found for %; skipping', v_jobname;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = v_jobname) THEN
    RAISE NOTICE 'D-683b % already scheduled; skipping', v_jobname;
    RETURN;
  END IF;
  PERFORM cron.schedule(v_jobname, v_schedule, v_command);
  INSERT INTO public._d681_cron_pause_log(action, jobname, reason)
  VALUES ('restored', v_jobname, 'D-683b restore for today game settlement');
  RAISE NOTICE 'D-683b restored % schedule=%', v_jobname, v_schedule;
END $$;

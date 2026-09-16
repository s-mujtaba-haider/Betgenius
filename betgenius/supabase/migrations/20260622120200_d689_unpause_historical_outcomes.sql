-- D-689 SHIP 1B.3 — un-pause refresh-historical-outcomes-mlb-daily (covers
-- game_side.score_h2h_recent). Reads original schedule from snapshot.
DO $$
DECLARE
  v_schedule TEXT; v_command TEXT;
  v_jobname TEXT := 'refresh-historical-outcomes-mlb-daily';
BEGIN
  SELECT schedule, command INTO v_schedule, v_command
  FROM public._d681_cron_pause_log
  WHERE jobname = v_jobname AND action = 'snapshot'
  ORDER BY paused_at DESC LIMIT 1;
  IF v_schedule IS NULL THEN
    RAISE NOTICE 'D-689 NO snapshot for %', v_jobname; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = v_jobname) THEN
    RAISE NOTICE 'D-689 % already scheduled', v_jobname; RETURN;
  END IF;
  PERFORM cron.schedule(v_jobname, v_schedule, v_command);
  INSERT INTO public._d681_cron_pause_log(action, jobname, reason)
  VALUES ('restored', v_jobname, 'D-689 restore for h2h_recent');
  RAISE NOTICE 'D-689 restored % schedule=%', v_jobname, v_schedule;
END $$;

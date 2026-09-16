-- D-689 SHIP 1B.1 — un-pause fetch-mlb-batter-splits (covers 4× score_handedness_matchup).
-- Reads original (schedule, command) from _d681_cron_pause_log snapshot row so
-- behavior matches pre-pause byte-for-byte.
DO $$
DECLARE
  v_schedule TEXT;
  v_command TEXT;
  v_jobname TEXT := 'fetch-mlb-batter-splits';
BEGIN
  SELECT schedule, command INTO v_schedule, v_command
  FROM public._d681_cron_pause_log
  WHERE jobname = v_jobname AND action = 'snapshot'
  ORDER BY paused_at DESC LIMIT 1;
  IF v_schedule IS NULL THEN
    RAISE NOTICE 'D-689 NO snapshot for %', v_jobname;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = v_jobname) THEN
    RAISE NOTICE 'D-689 % already scheduled', v_jobname;
    RETURN;
  END IF;
  PERFORM cron.schedule(v_jobname, v_schedule, v_command);
  INSERT INTO public._d681_cron_pause_log(action, jobname, reason)
  VALUES ('restored', v_jobname, 'D-689 restore for handedness_matchup × 4 markets');
  RAISE NOTICE 'D-689 restored % schedule=%', v_jobname, v_schedule;
END $$;

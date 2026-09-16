-- D-683b SHIP 1.3 — restore fetch-mlb-boxscores-daily from
-- _d681_cron_pause_log snapshot. Required for today's box scores to land
-- in cache so resolve-picks-daily can settle bets.
DO $$
DECLARE
  v_schedule TEXT;
  v_command TEXT;
  v_jobname TEXT := 'fetch-mlb-boxscores-daily';
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

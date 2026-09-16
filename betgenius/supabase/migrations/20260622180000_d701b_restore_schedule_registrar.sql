-- D-701b SHIP 2 — restore register-game-schedule-hourly from _d681_cron_pause_log
-- Mirrors the D-683b restore pattern (lineup-watcher / boxscores / scoreboard-status).
-- D-681 unscheduled this 14h ago at midnight ET; both D-683b and D-689 restore passes missed it.

DO $$
DECLARE
  v_jobname TEXT := 'register-game-schedule-hourly';
  v_schedule TEXT;
  v_command  TEXT;
  v_already_scheduled BOOLEAN;
  v_jobid    BIGINT;
BEGIN
  -- 1. Already scheduled? (defensive)
  SELECT EXISTS(SELECT 1 FROM cron.job WHERE jobname = v_jobname) INTO v_already_scheduled;
  IF v_already_scheduled THEN
    RAISE NOTICE 'D-701b: % is already scheduled; skipping re-schedule', v_jobname;
    -- Still record an inventory row for traceability
    INSERT INTO public._d681_cron_pause_log(action, jobname, reason)
    VALUES ('already_scheduled', v_jobname, 'D-701b found it already restored — no-op');
    RETURN;
  END IF;

  -- 2. Pull snapshot of original (schedule, command)
  SELECT schedule, command INTO v_schedule, v_command
  FROM public._d681_cron_pause_log
  WHERE jobname = v_jobname AND action = 'snapshot'
  ORDER BY paused_at DESC LIMIT 1;

  IF v_schedule IS NULL THEN
    RAISE EXCEPTION 'D-701b: NO snapshot found for % in _d681_cron_pause_log — cannot restore', v_jobname;
  END IF;

  -- 3. Re-schedule
  PERFORM cron.schedule(v_jobname, v_schedule, v_command);

  -- 4. Capture jobid for the inventory log
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = v_jobname;

  INSERT INTO public._d681_cron_pause_log(action, jobname, schedule, command, reason)
  VALUES ('restored', v_jobname, v_schedule, v_command,
          format('D-701b restore. jobid=%s. paused 14h by D-681 — missed by D-683b + D-689 passes', v_jobid));

  RAISE NOTICE 'D-701b restored % jobid=% schedule=%', v_jobname, v_jobid, v_schedule;
END $$;

-- 5. Echo final state — confirm cron row exists + record current scheduled crons for D-701b inventory
DROP TABLE IF EXISTS d701b_cron_state;
CREATE TABLE d701b_cron_state AS
SELECT jobid, jobname, schedule, active, command
FROM cron.job
ORDER BY jobname;

SELECT 'D-701b: ' || count(*) || ' active crons after restore' FROM cron.job WHERE active;

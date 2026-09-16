-- D-701b SHIP 3 — kick off register-game-schedule-hourly NOW.
-- SHIP 5 — also audit which other paused crons are still missing.

-- Capture the cron's command + execute it
DROP TABLE IF EXISTS d701b_kickoff_log;
CREATE TABLE d701b_kickoff_log (
  step TEXT, info TEXT, n INT
);

DO $$
DECLARE
  v_command TEXT;
  v_jobid BIGINT;
  v_schedule TEXT;
BEGIN
  SELECT command, jobid, schedule INTO v_command, v_jobid, v_schedule
  FROM cron.job WHERE jobname = 'register-game-schedule-hourly';

  IF v_command IS NULL THEN
    RAISE EXCEPTION 'D-701b kickoff: jobname register-game-schedule-hourly not in cron.job';
  END IF;

  INSERT INTO d701b_kickoff_log(step, info)
  VALUES ('precheck', format('jobid=%s schedule=%s', v_jobid, v_schedule)),
         ('command_preview', left(v_command, 200));

  -- Execute the cron's command directly. This is identical to what cron would
  -- run at top-of-:15. Safe — same code path.
  EXECUTE v_command;

  INSERT INTO d701b_kickoff_log(step, info)
  VALUES ('dispatched', 'register-game-schedule-hourly fired manually');
END $$;

-- Capture recent pg_net responses for traceability (the cron uses pg_net.http_post)
INSERT INTO d701b_kickoff_log(step, info, n)
SELECT 'recent_pg_net', left(coalesce(content::text,''), 120), status_code
FROM net._http_response
WHERE created > NOW() - INTERVAL '90 seconds'
ORDER BY created DESC LIMIT 5;

-- SHIP 5 — Other still-paused crons from D-681's list
DROP TABLE IF EXISTS d701b_pause_audit;
CREATE TABLE d701b_pause_audit (jobname TEXT, status TEXT, note TEXT);

INSERT INTO d701b_pause_audit(jobname, status, note)
SELECT p.jobname,
       CASE WHEN c.jobname IS NOT NULL THEN 'ACTIVE'
            ELSE 'STILL_PAUSED'
       END,
       CASE WHEN c.jobname IS NOT NULL THEN format('jobid=%s schedule=%s', c.jobid, c.schedule)
            ELSE 'no row in cron.job'
       END
FROM (
    SELECT DISTINCT jobname FROM public._d681_cron_pause_log WHERE action='unscheduled'
) p
LEFT JOIN cron.job c ON c.jobname = p.jobname
ORDER BY 2, 1;

-- Show full current cron.job state for the inventory
DROP TABLE IF EXISTS d701b_cron_state;
CREATE TABLE d701b_cron_state AS
SELECT jobid, jobname, schedule, active, left(command, 80) AS command_preview
FROM cron.job ORDER BY jobname;

SELECT 'D-701b kickoff + audit complete' AS done;

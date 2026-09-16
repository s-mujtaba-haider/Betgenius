-- D-613 v2 — pause process-games-progressive (NBA) via cron.alter_job
-- (direct UPDATE on cron.job failed with permission denied in v1; the
-- supported API for toggling active is cron.alter_job).

DO $$
DECLARE v_jobid bigint; v_active bool;
BEGIN
  SELECT jobid, active INTO v_jobid, v_active
    FROM cron.job WHERE jobname = 'process-games-progressive';

  IF v_jobid IS NULL THEN
    RAISE NOTICE '[D-613 pause] job not found';
  ELSIF v_active = false THEN
    RAISE NOTICE '[D-613 pause] already inactive (jobid=%)', v_jobid;
  ELSE
    PERFORM cron.alter_job(v_jobid, active := false);
    RAISE NOTICE '[D-613 pause] DEACTIVATED process-games-progressive (jobid=%)', v_jobid;
  END IF;

  SELECT active INTO v_active FROM cron.job WHERE jobid = v_jobid;
  RAISE NOTICE '[D-613 pause] confirmation: jobid=% active=%', v_jobid, v_active;
END $$;

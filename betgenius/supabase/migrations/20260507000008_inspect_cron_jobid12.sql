-- Read-only diagnostic: inspect jobid 12 cron config (May 7, 2026 evening Phase 6 sub-test).
--
-- We need to know whether jobid 12 exists, whether it points at run-optimizer
-- (old) or has been migrated, and how it authenticates. This drives both
-- Phase 6 test invocation strategy AND Phase 7 cron switch.
--
-- No mutations. Returns only NOTICE output.

DO $$
DECLARE
  v_count INTEGER;
  v_job RECORD;
  v_first_50 TEXT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM cron.job;
  RAISE NOTICE '[cron inspect] cron.job total rows: %', v_count;

  FOR v_job IN
    SELECT jobid, jobname, schedule, active, LEFT(command, 600) AS cmd_preview
    FROM cron.job
    ORDER BY jobid
  LOOP
    RAISE NOTICE '[cron inspect] jobid=% name=% schedule=% active=%',
      v_job.jobid, v_job.jobname, v_job.schedule, v_job.active;
    RAISE NOTICE '[cron inspect]   cmd: %', v_job.cmd_preview;
  END LOOP;

  -- Also check vault availability
  BEGIN
    SELECT COUNT(*) INTO v_count FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN';
    RAISE NOTICE '[cron inspect] vault BACKFILL_AUTH_TOKEN entries: %', v_count;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[cron inspect] vault.decrypted_secrets unavailable: %', SQLERRM;
  END;

  -- And list any vault secrets at all
  BEGIN
    FOR v_job IN SELECT name FROM vault.decrypted_secrets ORDER BY name LOOP
      RAISE NOTICE '[cron inspect] vault secret: %', v_job.name;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END $$;

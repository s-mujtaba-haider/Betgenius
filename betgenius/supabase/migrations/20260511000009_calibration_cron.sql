-- Cron jobid 13: calibration snapshot daily at 11:15 UTC.
-- After resolve-picks (jobid 1 = 15:00 UTC daily, but the nightly 5:30 UTC
-- has settled overnight bets) and BEFORE 14:00 UTC process-games slate.
-- Vault-auth pattern from D-108.

DO $$
DECLARE
  v_new_jobid BIGINT;
BEGIN
  -- Schedule new cron. cron.schedule returns the jobid; we don't pin it to
  -- 13 explicitly since pg_cron auto-assigns. Just check we don't
  -- double-schedule by jobname.
  IF NOT EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'calibration-snapshot-daily'
  ) THEN
    SELECT cron.schedule(
      'calibration-snapshot-daily',
      '15 11 * * *',   -- 11:15 UTC daily
      $cmd$
        SELECT net.http_post(
          url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/write-calibration-snapshot',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (
              SELECT decrypted_secret FROM vault.decrypted_secrets
              WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1
            ),
            'Content-Type', 'application/json'
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 30000
        );
      $cmd$
    ) INTO v_new_jobid;
    RAISE NOTICE 'scheduled calibration-snapshot-daily as jobid=%', v_new_jobid;
  ELSE
    RAISE NOTICE 'calibration-snapshot-daily already scheduled (idempotent skip)';
  END IF;
END $$;

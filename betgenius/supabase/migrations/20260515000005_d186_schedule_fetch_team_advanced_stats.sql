-- D-186 Phase 1 (May 15, 2026): schedule fetch-team-advanced-stats daily at
-- 13:00 UTC — between calibration-snapshot-daily (11:15 UTC) and the
-- 14:00 UTC process-games slate, so today's slate scores against today's
-- fresh GOAT-tier advanced snapshot. Vault-auth pattern from D-108
-- (verified working per commit a0ca0a5).

DO $$
DECLARE
  v_new_jobid BIGINT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'fetch-team-advanced-stats-daily'
  ) THEN
    SELECT cron.schedule(
      'fetch-team-advanced-stats-daily',
      '0 13 * * *',    -- 13:00 UTC daily
      $cmd$
        SELECT net.http_post(
          url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-team-advanced-stats',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (
              SELECT decrypted_secret FROM vault.decrypted_secrets
              WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1
            ),
            'Content-Type', 'application/json'
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 60000
        );
      $cmd$
    ) INTO v_new_jobid;
    RAISE NOTICE 'scheduled fetch-team-advanced-stats-daily as jobid=%', v_new_jobid;
  ELSE
    RAISE NOTICE 'fetch-team-advanced-stats-daily already scheduled (idempotent skip)';
  END IF;
END $$;

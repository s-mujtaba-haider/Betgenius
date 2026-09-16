-- D-217 Task 5.3 — schedule send-trial-ending-emails cron.
--
-- Daily 09:00 UTC. Vault auth pattern per D-108. Idempotent registration.

DO $$
DECLARE v_jobid BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname='send-trial-ending-emails-daily') THEN
    SELECT cron.schedule(
      'send-trial-ending-emails-daily',
      '0 9 * * *',
      $cmd$
        SELECT net.http_post(
          url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/send-trial-ending-emails',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='BACKFILL_AUTH_TOKEN' LIMIT 1),
            'Content-Type', 'application/json'
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 60000
        );
      $cmd$
    ) INTO v_jobid;
    RAISE NOTICE 'D-217 CRON: scheduled send-trial-ending-emails-daily as jobid=%', v_jobid;
  ELSE
    RAISE NOTICE 'D-217 CRON: send-trial-ending-emails-daily already scheduled';
  END IF;
END $$;

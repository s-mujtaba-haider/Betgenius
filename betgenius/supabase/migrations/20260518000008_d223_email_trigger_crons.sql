-- D-223 Task 6.4 — schedule process-deletion-requests + send-daily-digest crons.
--
-- jobid 23: process-deletion-requests-daily — daily 10:00 UTC. Finds
--           account_deletion_requests where scheduled_for <= NOW() AND
--           not canceled AND not executed. Cancels Stripe sub, deletes
--           auth.users, sends account_deleted email.
-- jobid 24: send-daily-digest-daily — daily 13:00 UTC. After the noon
--           ET process-games tick lands today's picks. Sends digest to
--           subscribers with user_preferences.email_notifications=true.
--
-- Both use vault BACKFILL_AUTH_TOKEN per D-108.

DO $$
DECLARE v_jobid BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname='process-deletion-requests-daily') THEN
    SELECT cron.schedule(
      'process-deletion-requests-daily',
      '0 10 * * *',
      $cmd$
        SELECT net.http_post(
          url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/process-deletion-requests',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='BACKFILL_AUTH_TOKEN' LIMIT 1),
            'Content-Type', 'application/json'
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 120000
        );
      $cmd$
    ) INTO v_jobid;
    RAISE NOTICE 'D-223 CRON: scheduled process-deletion-requests-daily as jobid=%', v_jobid;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname='send-daily-digest-daily') THEN
    SELECT cron.schedule(
      'send-daily-digest-daily',
      '0 13 * * *',
      $cmd$
        SELECT net.http_post(
          url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/send-daily-digest',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='BACKFILL_AUTH_TOKEN' LIMIT 1),
            'Content-Type', 'application/json'
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 120000
        );
      $cmd$
    ) INTO v_jobid;
    RAISE NOTICE 'D-223 CRON: scheduled send-daily-digest-daily as jobid=%', v_jobid;
  END IF;
END $$;

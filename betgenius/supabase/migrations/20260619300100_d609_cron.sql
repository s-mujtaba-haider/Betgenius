-- D-609 SHIP 3 — hourly pg_cron schedule for system-health.
-- Mirrors D-459's pattern but with a different schedule (12 past the hour)
-- so it doesn't collide with D-459 at :07.

DO $$
DECLARE
  v_vault_len INTEGER;
  v_existing_jobid BIGINT;
BEGIN
  SELECT length(decrypted_secret) INTO v_vault_len
    FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_vault_len IS NULL OR v_vault_len = 0 THEN
    RAISE EXCEPTION '[D-609] vault.decrypted_secrets has no BACKFILL_AUTH_TOKEN — abort.';
  END IF;

  SELECT jobid INTO v_existing_jobid FROM cron.job WHERE jobname = 'd609-system-health-hourly';

  IF v_existing_jobid IS NOT NULL THEN
    PERFORM cron.alter_job(
      v_existing_jobid,
      schedule := '12 * * * *',
      command := $cmd$
        SELECT net.http_post(
          url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/system-health',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
            'Content-Type', 'application/json'
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 30000
        );
      $cmd$
    );
    RAISE NOTICE '[D-609] altered existing cron jobid=%', v_existing_jobid;
  ELSE
    PERFORM cron.schedule(
      'd609-system-health-hourly',
      '12 * * * *',
      $cmd$
        SELECT net.http_post(
          url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/system-health',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
            'Content-Type', 'application/json'
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 30000
        );
      $cmd$
    );
    RAISE NOTICE '[D-609] scheduled new cron d609-system-health-hourly';
  END IF;
END $$;

-- D-653 SHIP 2 — daily cron for fetch-mlb-team-oaa.
-- Fires at 10:00 UTC daily, before the 13:00 UTC MLB scoring window opens.
-- Vault BACKFILL_AUTH_TOKEN is the same token process-games-mlb uses.
DO $$
DECLARE
  v_url TEXT := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-mlb-team-oaa';
  v_token TEXT;
BEGIN
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_token IS NULL THEN
    RAISE NOTICE 'BACKFILL_AUTH_TOKEN missing — cron schedule deferred. Run fetch-mlb-team-oaa manually.';
    RETURN;
  END IF;

  -- Remove any prior schedule (idempotent re-deploy).
  PERFORM cron.unschedule('fetch-mlb-team-oaa-daily') WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'fetch-mlb-team-oaa-daily'
  );

  PERFORM cron.schedule(
    'fetch-mlb-team-oaa-daily',
    '0 10 * * *',  -- daily at 10:00 UTC = 6am ET, before 13:00 UTC scoring window
    format(
      $cron$SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || %L
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 30000
      );$cron$,
      v_url,
      v_token
    )
  );
  RAISE NOTICE 'D-653 cron scheduled: fetch-mlb-team-oaa-daily @ 10:00 UTC';
END $$;

-- D-664 SHIP 1 (C) — daily cron for fetch-mlb-pitcher-pen-extras-daily.
-- Fires at 11:00 UTC daily, AFTER OAA cron (10:00 UTC) and BEFORE the
-- 13:00 UTC pregame scoring window opens. ~5-8 min runtime expected for
-- 30 teams × roster scan + 30 SP gameLog fetches; well inside the
-- pre-pregame buffer.
DO $$
DECLARE
  v_url TEXT := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-mlb-pitcher-pen-extras-daily';
  v_token TEXT;
BEGIN
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_token IS NULL THEN
    RAISE NOTICE 'BACKFILL_AUTH_TOKEN missing — D-664 cron deferred. Run fetch-mlb-pitcher-pen-extras-daily manually.';
    RETURN;
  END IF;

  PERFORM cron.unschedule('fetch-mlb-pitcher-pen-extras-daily') WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'fetch-mlb-pitcher-pen-extras-daily'
  );

  PERFORM cron.schedule(
    'fetch-mlb-pitcher-pen-extras-daily',
    '0 11 * * *',  -- daily at 11:00 UTC, between OAA cron (10:00 UTC) and pregame (13:00 UTC)
    format(
      $cron$SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || %L
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 540000
      );$cron$,
      v_url,
      v_token
    )
  );
  RAISE NOTICE 'D-664 cron scheduled: fetch-mlb-pitcher-pen-extras-daily @ 11:00 UTC';
END $$;

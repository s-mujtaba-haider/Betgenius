-- D-669 SHIP 1 — daily cron for fetch-mlb-pitcher-inn1-daily.
-- Fires at 11:30 UTC daily, after D-664 pitcher-pen-extras (11:00 UTC) and
-- before pregame 13:00 UTC. Bounded compute: ~60 probable SPs × 1 API call.
DO $$
DECLARE
  v_url TEXT := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-mlb-pitcher-inn1-daily';
  v_token TEXT;
BEGIN
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_token IS NULL THEN
    RAISE NOTICE 'BACKFILL_AUTH_TOKEN missing — D-669 inn1 cron deferred.';
    RETURN;
  END IF;

  PERFORM cron.unschedule('fetch-mlb-pitcher-inn1-daily') WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'fetch-mlb-pitcher-inn1-daily'
  );

  PERFORM cron.schedule(
    'fetch-mlb-pitcher-inn1-daily',
    '30 11 * * *',  -- daily 11:30 UTC
    format(
      $cron$SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || %L
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 180000
      );$cron$,
      v_url,
      v_token
    )
  );
  RAISE NOTICE 'D-669 cron scheduled: fetch-mlb-pitcher-inn1-daily @ 11:30 UTC';

  -- Fire once now so today's pregame tick has data.
  PERFORM net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_token),
    body := '{}'::jsonb,
    timeout_milliseconds := 180000
  );
  RAISE NOTICE 'D-669 first-run dispatched: fetch-mlb-pitcher-inn1-daily';
END $$;

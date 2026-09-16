-- D-669 SHIP 2 — weekly cron for fetch-savant-team-chase-weekly.
-- Fires weekly Sunday 9 AM UTC. Bounded compute: 1 Savant fetch + 30 roster
-- fetches (~30 × 350ms = 11s throttled).
DO $$
DECLARE
  v_url TEXT := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-savant-team-chase-weekly';
  v_token TEXT;
BEGIN
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_token IS NULL THEN
    RAISE NOTICE 'BACKFILL_AUTH_TOKEN missing — D-669 chase cron deferred.';
    RETURN;
  END IF;

  PERFORM cron.unschedule('fetch-savant-team-chase-weekly') WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'fetch-savant-team-chase-weekly'
  );

  PERFORM cron.schedule(
    'fetch-savant-team-chase-weekly',
    '0 9 * * 0',  -- Sunday 9 AM UTC
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
  RAISE NOTICE 'D-669 cron scheduled: fetch-savant-team-chase-weekly @ Sunday 9 UTC';
END $$;

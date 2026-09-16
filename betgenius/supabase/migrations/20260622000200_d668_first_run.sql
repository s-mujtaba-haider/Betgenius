-- D-668 first-run — fire fetch-mlb-team-stats so bb_rate/obp/pitches_per_pa
-- are populated before today's 17:00 UTC live tick.
DO $$
DECLARE
  v_token TEXT;
BEGIN
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_token IS NULL THEN
    RAISE NOTICE 'BACKFILL_AUTH_TOKEN missing — D-668 first-run deferred.';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-mlb-team-stats',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_token),
    body := '{}'::jsonb,
    timeout_milliseconds := 180000
  );
  RAISE NOTICE 'D-668 first-run dispatched: fetch-mlb-team-stats (bb_rate / obp_season / pitches_per_pa populate)';
END $$;

-- D-473 SHIP 2 second trigger: with a fake-scored row in place to verify the
-- already_scored_count read picks it up.
DO $$
BEGIN
  PERFORM net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/process-games-mlb',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{"game_date":"20260607"}'::jsonb,
    timeout_milliseconds := 150000
  );
END $$;

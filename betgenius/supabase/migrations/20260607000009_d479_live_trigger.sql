-- D-479 SHIP 3 live trigger: verify post-cap deploy boots clean + cluster picks surface at the new cap.
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

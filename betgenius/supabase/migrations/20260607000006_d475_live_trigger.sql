-- D-475 SHIP 2 live trigger: verify scoreBatterRunsScored produces real picks
-- on today's slate (392 runs_scored props in cache; should produce >0 picks
-- at conf>=70 after D-473 sharding limits to N=2 games).
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

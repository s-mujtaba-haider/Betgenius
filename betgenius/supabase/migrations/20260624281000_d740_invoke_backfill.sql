-- D-740 STEP 1B — Run the season-stats backfill for all 169 distinct June pitchers.

SELECT net.http_post(
  url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/backfill-pitcher-season-stats',
  headers := jsonb_build_object('Content-Type','application/json',
    'Authorization','Bearer '||(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='BACKFILL_AUTH_TOKEN' LIMIT 1)),
  body := jsonb_build_object('season', 2026),
  timeout_milliseconds := 150000
);

-- D-749 — Trigger fetch-pitcher-csw to backfill 2026 season CSW data.
SELECT net.http_post(
  url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-pitcher-csw',
  headers := jsonb_build_object('Content-Type','application/json',
    'Authorization','Bearer '||(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='BACKFILL_AUTH_TOKEN' LIMIT 1)),
  body := jsonb_build_object('year', 2026),
  timeout_milliseconds := 120000
);

-- D-737f-B — Invoke rescore-historic-pitcher-k dry-run via pg_net + vault BACKFILL token.
-- Small window (3 days, 15 picks) to verify the function executes correctly.

SELECT net.http_post(
  url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/rescore-historic-pitcher-k',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1)
  ),
  body := jsonb_build_object('start_date', '2026-06-21', 'end_date', '2026-06-23', 'limit', 15, 'dry_run', true)
);

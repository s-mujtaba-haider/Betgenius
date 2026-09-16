-- D-737f-B — Full re-score run via pg_net + vault BACKFILL token.
-- Range: opening day through yesterday. Limit 1500 to safely cover all 1,096 resolved picks.

SELECT net.http_post(
  url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/rescore-historic-pitcher-k',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1)
  ),
  body := jsonb_build_object('start_date', '2026-03-26', 'end_date', '2026-06-23', 'limit', 1500, 'dry_run', false),
  timeout_milliseconds := 150000
);

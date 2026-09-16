-- D-737f-C — Determinism rerun: same window May 18-24, fresh tag, compare to first run.

SELECT net.http_post(
  url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/rescore-historic-pitcher-k',
  headers := jsonb_build_object('Content-Type','application/json',
    'Authorization','Bearer '||(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='BACKFILL_AUTH_TOKEN' LIMIT 1)),
  body := jsonb_build_object('start_date','2026-05-18','end_date','2026-05-24','limit',300,'dry_run',false),
  timeout_milliseconds := 150000
);

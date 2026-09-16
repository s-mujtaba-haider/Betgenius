-- D-740 STEP 2 — clear June rescore rows + re-invoke rescore-historic-pitcher-k
-- with the D-740 router pointing at cache_mlb_pitcher_season_stats + all-appearances gameLog.

DELETE FROM pitcher_k_rescore_results
WHERE game_date >= '2026-06-01' AND game_date < '2026-06-25';

SELECT net.http_post(
  url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/rescore-historic-pitcher-k',
  headers := jsonb_build_object('Content-Type','application/json',
    'Authorization','Bearer '||(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='BACKFILL_AUTH_TOKEN' LIMIT 1)),
  body := jsonb_build_object('start_date','2026-06-01','end_date','2026-06-07','limit',300,'dry_run',false),
  timeout_milliseconds := 150000
);

SELECT net.http_post(
  url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/rescore-historic-pitcher-k',
  headers := jsonb_build_object('Content-Type','application/json',
    'Authorization','Bearer '||(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='BACKFILL_AUTH_TOKEN' LIMIT 1)),
  body := jsonb_build_object('start_date','2026-06-08','end_date','2026-06-15','limit',300,'dry_run',false),
  timeout_milliseconds := 150000
);

SELECT net.http_post(
  url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/rescore-historic-pitcher-k',
  headers := jsonb_build_object('Content-Type','application/json',
    'Authorization','Bearer '||(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='BACKFILL_AUTH_TOKEN' LIMIT 1)),
  body := jsonb_build_object('start_date','2026-06-16','end_date','2026-06-23','limit',400,'dry_run',false),
  timeout_milliseconds := 150000
);

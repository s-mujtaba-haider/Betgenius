-- D-746 STEP 3 — Re-rescore the held-out validate window (Jun 10-23) with the
-- now-restored D-746 weights. The deployed scorePitcherStrikeouts reads
-- algorithm_weights at runtime, so the new weights take effect on re-rescore.

DELETE FROM pitcher_k_rescore_results
WHERE game_date >= '2026-06-10' AND game_date < '2026-06-24';

SELECT net.http_post(
  url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/rescore-historic-pitcher-k',
  headers := jsonb_build_object('Content-Type','application/json',
    'Authorization','Bearer '||(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='BACKFILL_AUTH_TOKEN' LIMIT 1)),
  body := jsonb_build_object('start_date','2026-06-10','end_date','2026-06-15','limit',300,'dry_run',false),
  timeout_milliseconds := 150000
);

SELECT net.http_post(
  url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/rescore-historic-pitcher-k',
  headers := jsonb_build_object('Content-Type','application/json',
    'Authorization','Bearer '||(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='BACKFILL_AUTH_TOKEN' LIMIT 1)),
  body := jsonb_build_object('start_date','2026-06-16','end_date','2026-06-23','limit',400,'dry_run',false),
  timeout_milliseconds := 150000
);

-- D-749 — Backtest the new CSW factor on the held-out validate window.
-- READ-ONLY for production weights (no UPDATE on algorithm_weights).
-- We just clear + re-rescore the validate window so the new factor lights up.

-- Cron stays paused (verified D-747-DEPLOY).
-- Snapshot current weights for parity (we are NOT changing weights here —
-- the only code change that affects scoring is the new factor in the
-- already-deployed scoring_mlb_v2.ts).
CREATE TABLE IF NOT EXISTS algorithm_weights_d749_pre AS
  SELECT *, now() AS snapshot_at FROM algorithm_weights WHERE id = 1;

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

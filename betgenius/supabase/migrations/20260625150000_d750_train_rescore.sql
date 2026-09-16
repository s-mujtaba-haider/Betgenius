-- D-750 — Rescore TRAIN window with CSW active so we can fit a new isotonic
-- calibration. The held-out validate window (Jun 10-23) is already rescored
-- per D-749 v2. Train fits the curve, validate checks it.
--
-- READ-ONLY for weights (algorithm_weights snapshot exists from D-747-DEPLOY).

DELETE FROM pitcher_k_rescore_results
WHERE game_date >= '2026-05-01' AND game_date < '2026-06-10';

-- Two batches to keep each call under the edge function 150s timeout.
SELECT net.http_post(
  url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/rescore-historic-pitcher-k',
  headers := jsonb_build_object('Content-Type','application/json',
    'Authorization','Bearer '||(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='BACKFILL_AUTH_TOKEN' LIMIT 1)),
  body := jsonb_build_object('start_date','2026-05-01','end_date','2026-05-20','limit',500,'dry_run',false),
  timeout_milliseconds := 150000
);

SELECT net.http_post(
  url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/rescore-historic-pitcher-k',
  headers := jsonb_build_object('Content-Type','application/json',
    'Authorization','Bearer '||(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='BACKFILL_AUTH_TOKEN' LIMIT 1)),
  body := jsonb_build_object('start_date','2026-05-21','end_date','2026-06-09','limit',500,'dry_run',false),
  timeout_milliseconds := 150000
);

-- D-737f-B — Invoke rescore in date chunks (function timed out at ~211 picks on full window).
-- 4 chunks by month covering 2026-03-26 → 2026-06-23.

SELECT net.http_post(
  url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/rescore-historic-pitcher-k',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1)
  ),
  body := jsonb_build_object('start_date','2026-03-26','end_date','2026-04-30','limit',500,'dry_run',false),
  timeout_milliseconds := 150000
);

SELECT net.http_post(
  url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/rescore-historic-pitcher-k',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1)
  ),
  body := jsonb_build_object('start_date','2026-05-01','end_date','2026-05-17','limit',500,'dry_run',false),
  timeout_milliseconds := 150000
);

SELECT net.http_post(
  url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/rescore-historic-pitcher-k',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1)
  ),
  body := jsonb_build_object('start_date','2026-05-25','end_date','2026-06-08','limit',500,'dry_run',false),
  timeout_milliseconds := 150000
);

SELECT net.http_post(
  url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/rescore-historic-pitcher-k',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1)
  ),
  body := jsonb_build_object('start_date','2026-06-09','end_date','2026-06-23','limit',500,'dry_run',false),
  timeout_milliseconds := 150000
);

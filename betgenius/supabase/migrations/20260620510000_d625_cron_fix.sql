-- D-625 SHIP 3 — fix cron bodies for the 3 resolve-picks jobs.
-- D-625 diagnose found: with default body='{}'::jsonb the resolver fetches
-- limit=200 unscoped pick_history rows → PostgREST 8s statement_timeout
-- (SQLSTATE 57014) — captured in net._http_response id=30319 at
-- 2026-06-19 15:00:00 with body:
--   {"success":false,"error":"picks query failed: status=500 body=
--    {\"code\":\"57014\",\"message\":\"canceling statement due to statement timeout\"}"}
-- pg_cron only sees the SELECT succeed (1 row = the net.http_post req id),
-- so cron.job_run_details showed "succeeded" while resolve-picks returned
-- 500 internally. Today's 5:30/15:00/15:30 UTC runs all 500'd → 0 picks
-- resolved in last 24h despite 3 "succeeded" cron runs.
--
-- Fix: change cron body to '{"sport":"mlb","limit":100}'.
--   - sport=mlb adds an index-friendly predicate (we just resolved 90
--     picks in 15.3s with this config via manual probe id=30553).
--   - limit=100 keeps the query under the 8s deadline AND keeps the
--     resolver run under the 150s edge-function ceiling.
-- 3 runs/day × 100 = 300/day max. With ~6,770 handled-but-stuck
-- (excluding the 3 newly-handled markets from SHIP 2), this drains in
-- ~22 days at cron pace OR a few hours at manual-backfill pace.
-- Backfill plan: SHIP 4 manual invocation drains the queue.
--
-- ROLLBACK: cron.alter_job(jobid, command := '<original-command>') with
-- body := '{}'::jsonb. The original commands are captured in the
-- D-625 doc + framework §15.

SELECT cron.alter_job(
  job_id := 1,
  command := $cmd$
      SELECT net.http_post(
        url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/resolve-picks',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
          'Content-Type', 'application/json'
        ),
        body := '{"sport":"mlb","limit":100}'::jsonb,
        timeout_milliseconds := 120000
      );
    $cmd$
);

SELECT cron.alter_job(
  job_id := 2,
  command := $cmd$
      SELECT net.http_post(
        url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/resolve-picks',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
          'Content-Type', 'application/json'
        ),
        body := '{"sport":"mlb","limit":100}'::jsonb,
        timeout_milliseconds := 120000
      );
    $cmd$
);

SELECT cron.alter_job(
  job_id := 3,
  command := $cmd$
      SELECT net.http_post(
        url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/resolve-picks',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
          'Content-Type', 'application/json'
        ),
        body := '{"sport":"mlb","limit":100}'::jsonb,
        timeout_milliseconds := 120000
      );
    $cmd$
);

-- D-506 SHIP 3 — temporary every-minute cron to drain the 16,445 backfill queue.
--
-- Each call to resolve-picks processes 200 picks (the queue head, oldest by
-- created_at ASC, capped at 14-day game_date window). At 200/run × 1 run/min
-- the queue drains in ~82 minutes.
--
-- This cron is INTENTIONALLY TEMPORARY: a follow-up migration (immediately
-- after queue drains, expected ~12:30 PM ET 2026-06-10) will unschedule
-- jobid (TBD assigned by pg_cron). If the unschedule migration fails to
-- apply for any reason, MANUAL CLEANUP via:
--   SELECT cron.unschedule(<jobid>);
--   -- OR by name:
--   SELECT cron.unschedule('resolve-picks-d506-backfill');
--
-- The existing three resolve-picks cron jobs (jobid 1, 2, 3) stay scheduled
-- and unchanged; this is additive only.

SELECT cron.schedule(
  'resolve-picks-d506-backfill',
  '* * * * *',
  $$
    SELECT net.http_post(
      url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/resolve-picks',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 150000
    );
  $$
);

DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-506 SHIP 3] backfill cron scheduled:';
  FOR r IN
    SELECT jobid, jobname, schedule, active FROM cron.job
    WHERE jobname = 'resolve-picks-d506-backfill'
  LOOP
    RAISE NOTICE '  jobid=% name=% sched=% active=%', r.jobid, r.jobname, r.schedule, r.active;
  END LOOP;
END $$;

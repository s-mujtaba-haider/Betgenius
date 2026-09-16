-- D-506 — re-schedule the backfill cron after accidental early unschedule.
-- Migration 62 ran before drain completed (operator-induced via --include-all
-- with prepped SHIP 4 migrations); re-schedule the every-minute cron now.
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
  RAISE NOTICE '[D-506] backfill cron RE-scheduled:';
  FOR r IN SELECT jobid, jobname, schedule, active FROM cron.job
    WHERE jobname = 'resolve-picks-d506-backfill'
  LOOP RAISE NOTICE '  jobid=% name=% sched=% active=%', r.jobid, r.jobname, r.schedule, r.active; END LOOP;
END $$;

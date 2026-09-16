-- D-506 — re-schedule backfill cron AGAIN. Previous jobid 44 was
-- prematurely unscheduled by mig 20260610000070 when the operator's
-- background drain monitor ran `db push --include-all` while mig 70
-- was already on disk as a prepped post-drain step. Pending count when
-- 44 died: ~11,000. The next regular cron tick is 15:00 UTC (~12 hours
-- away), so a manual every-minute cron is needed to drain in the
-- current session.
SELECT cron.schedule(
  'resolve-picks-d506-backfill-r3',
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
  RAISE NOTICE '[D-506] backfill cron round 3 scheduled:';
  FOR r IN SELECT jobid, jobname, schedule, active FROM cron.job
    WHERE jobname = 'resolve-picks-d506-backfill-r3'
  LOOP RAISE NOTICE '  jobid=% name=% sched=% active=%', r.jobid, r.jobname, r.schedule, r.active; END LOOP;
END $$;

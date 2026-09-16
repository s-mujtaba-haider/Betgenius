-- D-634 SHIP 3 — Snapshot writer cron.
-- Every 30 min during the active MLB game-window (mirrors
-- fetch-odds-mlb-30min so snapshots run on freshly-pulled odds).
SELECT cron.schedule(
  'snapshot-odds-writer-30min',
  '*/30 17-23,0-4 * * *',
  $$
    SELECT net.http_post(
      url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/snapshot-odds-writer',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
        'Content-Type', 'application/json'
      ),
      body := '{"sport":"mlb"}'::jsonb,
      timeout_milliseconds := 120000
    );
  $$
);

DO $$ DECLARE r RECORD; BEGIN
  RAISE NOTICE '[D-634 cron] schedule confirmed:';
  FOR r IN SELECT jobid, jobname, schedule, active FROM cron.job
   WHERE jobname = 'snapshot-odds-writer-30min'
  LOOP RAISE NOTICE '  jobid=% name=% sched=% active=%',
    r.jobid, r.jobname, r.schedule, r.active; END LOOP;
END $$;

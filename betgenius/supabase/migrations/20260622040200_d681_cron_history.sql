-- D-681 SHIP 1b — quick cron diagnostic. cron.job_run_details can be huge;
-- limit to last 30 minutes to stay under statement timeout.
DO $$
DECLARE r RECORD; BEGIN
  RAISE NOTICE 'D-681 — cron run history last 30min';
  FOR r IN
    SELECT j.jobname,
           EXTRACT(EPOCH FROM (jrd.end_time - jrd.start_time))::int AS dur_s,
           jrd.start_time
    FROM cron.job_run_details jrd
    JOIN cron.job j ON j.jobid = jrd.jobid
    WHERE jrd.start_time >= NOW() - INTERVAL '30 minutes'
    ORDER BY jrd.start_time DESC
    LIMIT 30
  LOOP
    RAISE NOTICE 'D-681 hist: % dur=%s at %', r.jobname, r.dur_s, r.start_time;
  END LOOP;

  RAISE NOTICE 'D-681 db size: %', pg_size_pretty(pg_database_size(current_database()));

  FOR r IN
    SELECT relname, pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r'
    ORDER BY pg_total_relation_size(c.oid) DESC
    LIMIT 10
  LOOP
    RAISE NOTICE 'D-681 top-table: % %', r.total_size, r.relname;
  END LOOP;

  -- pg_net queue + worker state
  PERFORM 1;
END $$;

-- One more NOTIFY in case the previous reload missed.
DO $$ BEGIN
  PERFORM pg_notify('pgrst', 'reload schema');
  PERFORM pg_notify('pgrst', 'reload config');
END $$;

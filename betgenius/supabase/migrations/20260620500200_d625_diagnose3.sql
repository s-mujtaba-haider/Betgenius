DO $$ DECLARE r RECORD; BEGIN
  -- §A — cron.job columns + sample row for a resolve job
  RAISE NOTICE '[A] cron.job columns:';
  FOR r IN SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='cron' AND table_name='job' ORDER BY ordinal_position LOOP
    RAISE NOTICE '  % (%)', r.column_name, r.data_type;
  END LOOP;
  RAISE NOTICE '';
  RAISE NOTICE '[A2] sample resolve-picks job all columns:';
  FOR r IN SELECT to_jsonb(j.*) AS j FROM cron.job j WHERE jobid = 1 LIMIT 1 LOOP
    RAISE NOTICE '  jobid=1: %', r.j;
  END LOOP;

  -- §B — run_log columns
  RAISE NOTICE '';
  RAISE NOTICE '[B] run_log columns:';
  FOR r IN SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='run_log' ORDER BY ordinal_position LOOP
    RAISE NOTICE '  % (%)', r.column_name, r.data_type;
  END LOOP;
END $$;

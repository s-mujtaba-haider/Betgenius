DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-506] full resolve-picks cron commands:';
  FOR r IN SELECT jobid, jobname, command FROM cron.job WHERE jobid IN (1,2,3) ORDER BY jobid LOOP
    RAISE NOTICE 'jobid=% jobname=% cmd_len=%', r.jobid, r.jobname, length(r.command);
    -- chunk-print
    RAISE NOTICE 'cmd[1:1000]=%', substring(r.command, 1, 1000);
    IF length(r.command) > 1000 THEN
      RAISE NOTICE 'cmd[1001:2000]=%', substring(r.command, 1001, 1000);
    END IF;
  END LOOP;
END $$;

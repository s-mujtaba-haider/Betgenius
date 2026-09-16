-- D-327 read-only migration: log MLB-related cron commands for analysis.
-- NO writes to production tables. NO schema changes. Just RAISE NOTICE.
DO $$
DECLARE v_row RECORD;
BEGIN
  RAISE NOTICE '[D-327] MLB-related cron commands:';
  FOR v_row IN
    SELECT j.jobname, substring(j.command FROM 1 FOR 500) AS cmd
    FROM cron.job j
    WHERE j.jobname ILIKE '%mlb%' OR j.jobname ILIKE '%games%' OR j.jobname ILIKE '%odds%'
    ORDER BY j.jobname
  LOOP
    RAISE NOTICE '====== % ======', v_row.jobname;
    RAISE NOTICE '%', v_row.cmd;
  END LOOP;
END $$;

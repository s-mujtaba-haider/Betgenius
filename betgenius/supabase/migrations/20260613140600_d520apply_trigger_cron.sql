-- D-520-APPLY SHIP 2 §E.7 — invoke process-games-mlb via pg_cron's same
-- mechanism so a fresh batter pick is generated with the new factor in
-- breakdown. Then queryable to prove the factor fires live.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  -- Show the existing MLB process-games cron(s)
  RAISE NOTICE '[D-520-APPLY §E.7] existing process-games-mlb cron entries:';
  FOR r IN
    SELECT jobid, schedule, command, jobname, active
    FROM cron.job
    WHERE command ILIKE '%process-games-mlb%' OR jobname ILIKE '%mlb%'
    ORDER BY jobid
  LOOP RAISE NOTICE '  jobid=% schedule=% jobname=% active=% command=%',
    r.jobid, r.schedule, r.jobname, r.active, left(r.command, 200);
  END LOOP;
END $$;

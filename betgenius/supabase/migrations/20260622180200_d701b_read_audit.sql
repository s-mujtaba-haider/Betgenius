-- D-701b — read d701b_kickoff_log + d701b_pause_audit + d701b_cron_state via NOTICE
-- since PostgREST is still 503

DO $$
DECLARE rec record;
BEGIN
  RAISE NOTICE '=== KICKOFF LOG ===';
  FOR rec IN SELECT step, info, n FROM d701b_kickoff_log ORDER BY ctid LOOP
    RAISE NOTICE '  step=% n=% info=%', rec.step, COALESCE(rec.n::text,'-'), left(rec.info, 200);
  END LOOP;

  RAISE NOTICE '=== PAUSED-CRON AUDIT ===';
  FOR rec IN SELECT jobname, status, note FROM d701b_pause_audit ORDER BY status, jobname LOOP
    RAISE NOTICE '  [%] %  %', rec.status, rec.jobname, rec.note;
  END LOOP;

  RAISE NOTICE '=== ACTIVE CRONS (cron.job) ===';
  FOR rec IN SELECT jobid, jobname, schedule, active FROM cron.job WHERE active ORDER BY jobname LOOP
    RAISE NOTICE '  jobid=% [%] %  schedule=%', rec.jobid, CASE WHEN rec.active THEN 'ON' ELSE 'OFF' END, rec.jobname, rec.schedule;
  END LOOP;

  RAISE NOTICE '=== PG_NET recent responses (last 3 min) ===';
  FOR rec IN
    SELECT id, status_code, created, left(coalesce(content::text,''), 100) AS body
    FROM net._http_response
    WHERE created > NOW() - INTERVAL '3 minutes'
    ORDER BY created DESC LIMIT 8
  LOOP
    RAISE NOTICE '  id=% status=% created=% body=%', rec.id, rec.status_code, rec.created, rec.body;
  END LOOP;
END $$;

-- D-701c continuation — drops + reload notify (fix to PERFORM bug)

-- Drop D-700 diag tables (idempotent)
DROP TABLE IF EXISTS d700_inventory CASCADE;
DROP TABLE IF EXISTS d700_tablespec CASCADE;
DROP TABLE IF EXISTS d700_table_counts CASCADE;
DROP TABLE IF EXISTS d700_coverage CASCADE;
DROP TABLE IF EXISTS d700_join CASCADE;
DROP TABLE IF EXISTS d701b_kickoff_log CASCADE;
DROP TABLE IF EXISTS d701b_pause_audit CASCADE;
DROP TABLE IF EXISTS d701b_cron_state CASCADE;

-- Read diag table contents via NOTICE since REST is 503
DO $$
DECLARE rec record;
BEGIN
  RAISE NOTICE '=== d701c_diag ===';
  FOR rec IN SELECT section, info, n FROM d701c_diag ORDER BY section, n DESC LOOP
    RAISE NOTICE '  [%] % = %', rec.section, rec.info, rec.n;
  END LOOP;

  RAISE NOTICE '=== d701c_long_queries (snapshot pre-kill) ===';
  FOR rec IN SELECT pid, application_name, state, query_sec, q FROM d701c_long_queries LOOP
    RAISE NOTICE '  pid=% app=% state=% sec=% q=%', rec.pid, rec.application_name, rec.state, rec.query_sec, rec.q;
  END LOOP;

  RAISE NOTICE '=== d701c_postkill (current activity) ===';
  FOR rec IN SELECT pid, application_name, state, query_sec, q FROM d701c_postkill LOOP
    RAISE NOTICE '  pid=% app=% state=% sec=% q=%', rec.pid, rec.application_name, rec.state, rec.query_sec, rec.q;
  END LOOP;

  -- pg_notify reload (inside DO block now)
  PERFORM pg_notify('pgrst', 'reload schema');
  RAISE NOTICE 'pgrst reload dispatched';

  -- Show current pg_stat_activity by application
  RAISE NOTICE '=== current connections by application ===';
  FOR rec IN
    SELECT application_name, count(*) as n,
           count(*) FILTER (WHERE state='active') as active,
           count(*) FILTER (WHERE state='idle') as idle,
           count(*) FILTER (WHERE state='idle in transaction') as iit
    FROM pg_stat_activity GROUP BY application_name ORDER BY n DESC
  LOOP
    RAISE NOTICE '  app=% total=% active=% idle=% iit=%',
        COALESCE(rec.application_name,'(none)'), rec.n, rec.active, rec.idle, rec.iit;
  END LOOP;

  -- Most recent net._http_response — are we getting any 200s?
  RAISE NOTICE '=== last 5 pg_net responses ===';
  FOR rec IN
    SELECT id, status_code, created, left(coalesce(content::text,''), 80) AS body
    FROM net._http_response ORDER BY created DESC LIMIT 5
  LOOP
    RAISE NOTICE '  id=% status=% % body=%', rec.id, COALESCE(rec.status_code,0), rec.created::text, rec.body;
  END LOOP;
END $$;

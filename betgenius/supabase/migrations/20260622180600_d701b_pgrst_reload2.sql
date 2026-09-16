DO $$
DECLARE rec record;
BEGIN
  -- Send multiple reload notifications — sometimes only one is received
  PERFORM pg_notify('pgrst', 'reload schema');
  PERFORM pg_notify('pgrst', 'reload schema');
  PERFORM pg_notify('pgrst', 'reload config');
  RAISE NOTICE 'D-701b: 3x pg_notify dispatched';

  -- What's pg backend doing? Show ALL non-idle activity
  RAISE NOTICE '=== pg_stat_activity (all non-idle, all sessions) ===';
  FOR rec IN
    SELECT pid, datname, usename, application_name, state,
           EXTRACT(EPOCH FROM (NOW() - state_change))::int AS state_sec,
           left(coalesce(query, ''), 80) AS q
    FROM pg_stat_activity
    WHERE state != 'idle' OR application_name LIKE '%pgrst%' OR application_name LIKE '%PostgREST%'
    ORDER BY state, pid
  LOOP
    RAISE NOTICE '  pid=% app=% state=%(%s ago) user=% q=%',
        rec.pid, rec.application_name, rec.state, rec.state_sec, rec.usename, rec.q;
  END LOOP;

  -- Connection breakdown by app
  RAISE NOTICE '=== connections by application ===';
  FOR rec IN
    SELECT application_name, count(*) AS n, count(*) FILTER (WHERE state='active') AS active
    FROM pg_stat_activity
    GROUP BY application_name ORDER BY n DESC LIMIT 10
  LOOP
    RAISE NOTICE '  app=% total=% active=%', COALESCE(rec.application_name,'(none)'), rec.n, rec.active;
  END LOOP;
END $$;

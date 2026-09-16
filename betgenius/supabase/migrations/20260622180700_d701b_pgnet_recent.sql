DO $$
DECLARE rec record;
  v_n int;
  v_active_pgrst int;
BEGIN
  SELECT count(*) INTO v_n FROM net._http_response WHERE created > NOW() - INTERVAL '3 minutes';
  RAISE NOTICE 'pg_net last 3min: %', v_n;

  FOR rec IN
    SELECT status_code, count(*) AS n
    FROM net._http_response
    WHERE created > NOW() - INTERVAL '3 minutes'
    GROUP BY status_code ORDER BY n DESC
  LOOP
    RAISE NOTICE '  status=% n=%', COALESCE(rec.status_code::text,'pending'), rec.n;
  END LOOP;

  -- Is postgrest still actively running the schema-cache query?
  SELECT count(*) INTO v_active_pgrst
  FROM pg_stat_activity
  WHERE application_name = 'postgrest' AND state = 'active';
  RAISE NOTICE 'active postgrest sessions: %', v_active_pgrst;

  FOR rec IN
    SELECT pid, state, EXTRACT(EPOCH FROM (NOW() - state_change))::int AS state_sec,
           left(coalesce(query, ''), 80) AS q
    FROM pg_stat_activity
    WHERE application_name='postgrest'
  LOOP
    RAISE NOTICE '  pid=% state=% sec=% q=%', rec.pid, rec.state, rec.state_sec, rec.q;
  END LOOP;
END $$;

DO $$
DECLARE rec record;
  v_total int; v_failed int; v_recent int;
BEGIN
  -- pg_net traffic in last hour
  SELECT count(*) INTO v_total FROM net._http_response WHERE created > NOW() - INTERVAL '60 minutes';
  SELECT count(*) INTO v_failed FROM net._http_response WHERE created > NOW() - INTERVAL '60 minutes' AND (status_code IS NULL OR status_code >= 400);
  SELECT count(*) INTO v_recent FROM net._http_response WHERE created > NOW() - INTERVAL '10 minutes';
  RAISE NOTICE 'pg_net last 60min: total=% failed=% (10min total=%)', v_total, v_failed, v_recent;

  -- Failure status breakdown
  FOR rec IN
    SELECT status_code, count(*) AS n
    FROM net._http_response
    WHERE created > NOW() - INTERVAL '30 minutes'
    GROUP BY status_code ORDER BY n DESC
  LOOP
    RAISE NOTICE '  status=% n=%', COALESCE(rec.status_code::text,'(null/pending)'), rec.n;
  END LOOP;

  -- Sample bodies of recent failures
  RAISE NOTICE '--- recent failure samples ---';
  FOR rec IN
    SELECT id, status_code, created, left(coalesce(content::text,''), 180) AS body
    FROM net._http_response
    WHERE created > NOW() - INTERVAL '10 minutes'
      AND (status_code IS NULL OR status_code >= 400)
    ORDER BY created DESC LIMIT 6
  LOOP
    RAISE NOTICE '  id=% status=% created=% body=%', rec.id, COALESCE(rec.status_code,0), rec.created, rec.body;
  END LOOP;

  -- pg_stat_activity — how many DB connections, what's active?
  SELECT count(*) INTO v_total FROM pg_stat_activity;
  SELECT count(*) INTO v_failed FROM pg_stat_activity WHERE state='active';
  RAISE NOTICE 'pg_stat_activity total=% active=%', v_total, v_failed;

  -- Long-running queries (>30s)
  RAISE NOTICE '--- long queries ---';
  FOR rec IN
    SELECT pid, state, EXTRACT(EPOCH FROM (NOW() - query_start))::int AS sec,
           left(query, 100) AS q
    FROM pg_stat_activity
    WHERE state != 'idle' AND query_start IS NOT NULL
      AND NOW() - query_start > INTERVAL '30 seconds'
    ORDER BY query_start
  LOOP
    RAISE NOTICE '  pid=% state=% sec=% q=%', rec.pid, rec.state, rec.sec, rec.q;
  END LOOP;

  -- Did anything land in props_cache for today?
  SELECT count(*) INTO v_total FROM props_cache WHERE sport='mlb' AND game_date = '2026-06-22';
  RAISE NOTICE 'props_cache rows for 2026-06-22 MLB: %', v_total;

  SELECT count(DISTINCT event_id) INTO v_total FROM props_cache WHERE sport='mlb' AND game_date = '2026-06-22';
  RAISE NOTICE 'distinct event_ids in props_cache for today: %', v_total;
END $$;

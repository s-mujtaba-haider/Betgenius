DO $$ DECLARE r RECORD; v_n BIGINT; v_resp RECORD; BEGIN
  -- pull the most recent net._http_response row for resolve-picks (this run)
  FOR v_resp IN
    SELECT id, status_code, LEFT(content::TEXT, 400) AS body_preview, created
    FROM net._http_response
    WHERE created >= NOW() - INTERVAL '5 minutes'
    ORDER BY created DESC LIMIT 3
  LOOP
    RAISE NOTICE 'D-692 net._http_response id=% status=% created=%', v_resp.id, v_resp.status_code, v_resp.created;
    RAISE NOTICE '  body: %', v_resp.body_preview;
  END LOOP;

  -- current backlog count
  SELECT COUNT(*) INTO v_n FROM public.pick_history
  WHERE sport='mlb' AND is_synthetic=false AND hit IS NULL AND resolved_at IS NULL
    AND game_time::timestamptz < NOW() - INTERVAL '6 hours';
  RAISE NOTICE 'D-692 POST-RUN backlog: %', v_n;

  -- DB connection state
  SELECT COUNT(*) INTO v_n FROM pg_stat_activity;
  RAISE NOTICE 'D-692 total connections: %', v_n;
  SELECT COUNT(*) INTO v_n FROM pg_stat_activity
    WHERE state IN ('active','idle in transaction') AND NOW() - query_start > INTERVAL '30 seconds';
  RAISE NOTICE 'D-692 long-running queries (>30s): %', v_n;
END $$;

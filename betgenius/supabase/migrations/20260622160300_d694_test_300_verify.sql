DO $$ DECLARE r RECORD; v_n INT; BEGIN
  FOR r IN SELECT id, status_code, content::JSONB AS body FROM net._http_response
    WHERE created >= NOW() - INTERVAL '4 minutes' ORDER BY created DESC LIMIT 4
  LOOP
    RAISE NOTICE 'resp id=% status=% claimed=% dispatched=% failed=% skipped=% dur_ms=%',
      r.id, r.status_code, r.body->>'claimed', r.body->>'dispatched',
      r.body->>'failed', r.body->>'skipped', r.body->>'duration_ms';
  END LOOP;
  SELECT COUNT(*) INTO v_n FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND hit IS NULL AND resolved_at IS NULL
      AND game_time::timestamptz >= '2026-06-21T00:00:00Z' AND game_time::timestamptz < '2026-06-22T00:00:00Z';
  RAISE NOTICE 'D-694 yesterday pending AFTER: %', v_n;
  -- check DB connection count + long queries
  SELECT COUNT(*) INTO v_n FROM pg_stat_activity;
  RAISE NOTICE 'D-694 total connections: %', v_n;
  SELECT COUNT(*) INTO v_n FROM pg_stat_activity WHERE state='active' AND NOW() - query_start > INTERVAL '30 seconds';
  RAISE NOTICE 'D-694 long queries (>30s): %', v_n;
END $$;

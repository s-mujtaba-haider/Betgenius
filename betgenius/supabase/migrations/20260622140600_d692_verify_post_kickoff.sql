DO $$ DECLARE r RECORD; v_backlog INT; BEGIN
  SELECT COUNT(*) INTO v_backlog FROM public.pick_history
  WHERE sport='mlb' AND is_synthetic=false AND hit IS NULL AND resolved_at IS NULL
    AND game_time::timestamptz < NOW() - INTERVAL '6 hours';
  RAISE NOTICE 'D-692 POST-KICKOFF backlog: % (started at 8786)', v_backlog;

  RAISE NOTICE '──── recent net._http_response (resolver responses) ────';
  FOR r IN
    SELECT id, status_code, created, LEFT(content::TEXT, 250) AS body
    FROM net._http_response
    WHERE created >= NOW() - INTERVAL '10 minutes'
    ORDER BY created DESC LIMIT 4
  LOOP
    RAISE NOTICE 'http_resp id=% status=% at=%', r.id, r.status_code, r.created;
    RAISE NOTICE '  body: %', r.body;
  END LOOP;

  RAISE NOTICE '──── run_log so far ────';
  FOR r IN SELECT id, run_at, backlog_before, db_health_ok, skip_reason, http_request_id
    FROM public.resolve_backlog_run_log ORDER BY id DESC LIMIT 5
  LOOP
    RAISE NOTICE '  log id=% run_at=% backlog=% ok=% reason=% rid=%',
      r.id, r.run_at, r.backlog_before, r.db_health_ok, COALESCE(r.skip_reason,'(fired)'), r.http_request_id;
  END LOOP;
END $$;

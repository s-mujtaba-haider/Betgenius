DO $$ DECLARE r RECORD; v_n INT; BEGIN
  -- Backlog now
  SELECT COUNT(*) INTO v_n FROM public.pick_history
  WHERE sport='mlb' AND is_synthetic=false AND hit IS NULL AND resolved_at IS NULL
    AND game_time::timestamptz < NOW() - INTERVAL '6 hours';
  RAISE NOTICE 'D-692 FINAL backlog: % (started 8786, after 2 manual drains)', v_n;

  -- Unresolvable candidates RIGHT NOW (>10 days old)
  SELECT COUNT(*) INTO v_n FROM public.pick_history
  WHERE sport='mlb' AND is_synthetic=false AND hit IS NULL AND resolved_at IS NULL AND voided=false
    AND game_time::timestamptz < NOW() - INTERVAL '10 days';
  RAISE NOTICE 'D-692 unresolvable candidates (>10d old, still unresolved): %', v_n;

  -- Cron confirmed
  FOR r IN SELECT jobid, jobname, schedule, active FROM cron.job
    WHERE jobname = 'd692-drain-resolver-backlog'
  LOOP RAISE NOTICE 'D-692 cron CONFIRMED: jobid=% % schedule=% active=%', r.jobid, r.jobname, r.schedule, r.active; END LOOP;

  -- Run log summary
  RAISE NOTICE '──── resolve_backlog_run_log so far ────';
  FOR r IN SELECT id, run_at, picks_resolved, backlog_before, db_health_ok, skip_reason, http_request_id
    FROM public.resolve_backlog_run_log ORDER BY id DESC LIMIT 6
  LOOP
    RAISE NOTICE '  log id=% run_at=% backlog_before=% ok=% rid=% reason=%',
      r.id, r.run_at, r.backlog_before, r.db_health_ok, COALESCE(r.http_request_id::TEXT,'(none)'),
      COALESCE(r.skip_reason,'(fired)');
  END LOOP;
END $$;

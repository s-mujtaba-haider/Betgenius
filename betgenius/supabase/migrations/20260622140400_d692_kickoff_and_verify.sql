DO $$ DECLARE r RECORD; v_n BIGINT; v_result TEXT; BEGIN
  -- Verify cron registered (proof, not claim)
  FOR r IN SELECT jobid, jobname, schedule, active FROM cron.job
    WHERE jobname = 'd692-drain-resolver-backlog'
  LOOP RAISE NOTICE 'D-692 cron REGISTERED: jobid=% name=% schedule=% active=%', r.jobid, r.jobname, r.schedule, r.active; END LOOP;

  -- Current UTC hour gate check (kickoff happens during current call; gate is INSIDE the function)
  RAISE NOTICE 'D-692 NOW UTC hour: %', EXTRACT(HOUR FROM NOW() AT TIME ZONE 'UTC');

  -- Kick off first run NOW (gate may or may not pass depending on hour; if not in window, run will skip and log)
  v_result := public.drain_resolver_backlog();
  RAISE NOTICE 'D-692 SHIP 7 — first invocation result: %', v_result;

  -- Show run_log so far
  RAISE NOTICE '──── run_log so far ────';
  FOR r IN SELECT id, run_at, picks_resolved, backlog_before, db_health_ok, skip_reason, http_request_id
    FROM public.resolve_backlog_run_log ORDER BY id DESC LIMIT 5
  LOOP
    RAISE NOTICE '  log id=% run_at=% backlog=% ok=% skip=% rid=%',
      r.id, r.run_at, r.backlog_before, r.db_health_ok, COALESCE(r.skip_reason,'(fired)'), r.http_request_id;
  END LOOP;
END $$;

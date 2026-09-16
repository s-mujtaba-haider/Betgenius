DO $$ DECLARE r RECORD; v_n INT; BEGIN
  -- yesterday pending now
  SELECT COUNT(*) INTO v_n FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND hit IS NULL AND resolved_at IS NULL
      AND game_time::timestamptz >= '2026-06-21T00:00:00Z' AND game_time::timestamptz < '2026-06-22T00:00:00Z';
  RAISE NOTICE 'D-694 FINAL yesterday-cohort pending: % (was 1467 last night)', v_n;

  -- total backlog
  SELECT COUNT(*) INTO v_n FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND hit IS NULL AND resolved_at IS NULL
      AND game_time::timestamptz < NOW() - INTERVAL '6 hours';
  RAISE NOTICE 'D-694 FINAL total backlog: % (was 8786 last night, 6586 this morning)', v_n;

  -- both crons confirmed registered
  FOR r IN SELECT jobid, jobname, schedule, active FROM cron.job
    WHERE jobname IN ('d692-drain-resolver-backlog','d694-recent-resolver') ORDER BY jobname
  LOOP RAISE NOTICE 'cron CONFIRMED jobid=% name=% schedule=% active=%', r.jobid, r.jobname, r.schedule, r.active; END LOOP;

  -- run-log summary today
  RAISE NOTICE '──── run_log last 4h ────';
  FOR r IN SELECT id, run_at, backlog_before, db_health_ok, skip_reason
    FROM public.resolve_backlog_run_log WHERE run_at >= NOW() - INTERVAL '4 hours'
    ORDER BY id DESC LIMIT 8
  LOOP
    RAISE NOTICE '  log id=% at=% backlog_before=% ok=% reason=%',
      r.id, r.run_at, r.backlog_before, r.db_health_ok, COALESCE(r.skip_reason,'(fired)');
  END LOOP;
END $$;

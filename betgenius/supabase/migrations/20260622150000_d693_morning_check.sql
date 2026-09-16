DO $$ DECLARE r RECORD; v_n BIGINT; v_total_fired INT; v_total_skipped INT; v_total_oow INT; v_total_unhealthy INT; BEGIN
  RAISE NOTICE '──── D-693 SHIP 1 — overnight run log (last 12h) ────';
  FOR r IN
    SELECT id, run_at, picks_resolved, backlog_before, db_health_ok, skip_reason, http_request_id
    FROM public.resolve_backlog_run_log
    WHERE run_at >= NOW() - INTERVAL '12 hours'
    ORDER BY run_at
  LOOP
    RAISE NOTICE 'log id=% at=% backlog_before=% ok=% rid=% reason=%',
      r.id, r.run_at, r.backlog_before, r.db_health_ok,
      COALESCE(r.http_request_id::TEXT,'(none)'),
      COALESCE(r.skip_reason,'(fired)');
  END LOOP;

  -- Aggregate
  SELECT
    COUNT(*) FILTER (WHERE db_health_ok=TRUE AND http_request_id IS NOT NULL),
    COUNT(*) FILTER (WHERE db_health_ok=FALSE),
    COUNT(*) FILTER (WHERE skip_reason LIKE 'out_of_window%'),
    COUNT(*) FILTER (WHERE skip_reason LIKE 'db_unhealthy%')
  INTO v_total_fired, v_total_skipped, v_total_oow, v_total_unhealthy
  FROM public.resolve_backlog_run_log WHERE run_at >= NOW() - INTERVAL '12 hours';
  RAISE NOTICE '──── aggregate 12h: fired=% / total_skipped=% (out_of_window=%, db_unhealthy=%) ────',
    v_total_fired, v_total_skipped, v_total_oow, v_total_unhealthy;

  -- Backlog now
  SELECT COUNT(*) INTO v_n FROM public.pick_history
  WHERE sport='mlb' AND is_synthetic=false AND hit IS NULL AND resolved_at IS NULL
    AND game_time::timestamptz < NOW() - INTERVAL '6 hours';
  RAISE NOTICE 'D-693 SHIP 3 — backlog NOW: % (started overnight at 8786, dropped 8786→8586 from manual pre-window fires)', v_n;

  -- Backlog by age
  RAISE NOTICE '──── current backlog age histogram ────';
  FOR r IN
    SELECT (NOW()::date - game_time::date) AS age_days, COUNT(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND hit IS NULL AND resolved_at IS NULL
      AND game_time::timestamptz < NOW() - INTERVAL '6 hours'
    GROUP BY age_days ORDER BY age_days
  LOOP RAISE NOTICE '  age_days=% n=%', r.age_days, r.n; END LOOP;

  -- SHIP 4 — yesterday's picks resolved vs pending
  RAISE NOTICE '──── SHIP 4 — yesterday cohort (2026-06-21 game_date) ────';
  SELECT COUNT(*) INTO v_n FROM public.pick_history
  WHERE sport='mlb' AND is_synthetic=false
    AND game_time::timestamptz >= '2026-06-21T00:00:00Z'
    AND game_time::timestamptz < '2026-06-22T00:00:00Z';
  RAISE NOTICE 'yesterday total non-synthetic MLB picks: %', v_n;
  SELECT COUNT(*) INTO v_n FROM public.pick_history
  WHERE sport='mlb' AND is_synthetic=false
    AND game_time::timestamptz >= '2026-06-21T00:00:00Z'
    AND game_time::timestamptz < '2026-06-22T00:00:00Z'
    AND (hit IS NOT NULL OR resolved_at IS NOT NULL);
  RAISE NOTICE '  resolved (hit OR resolved_at NOT NULL): %', v_n;
  SELECT COUNT(*) INTO v_n FROM public.pick_history
  WHERE sport='mlb' AND is_synthetic=false
    AND game_time::timestamptz >= '2026-06-21T00:00:00Z'
    AND game_time::timestamptz < '2026-06-22T00:00:00Z'
    AND hit IS NULL AND resolved_at IS NULL;
  RAISE NOTICE '  still pending: %', v_n;
END $$;

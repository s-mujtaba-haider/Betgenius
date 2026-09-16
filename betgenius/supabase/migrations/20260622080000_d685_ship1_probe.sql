-- D-685 SHIP 1 — READ-ONLY probe: is process-games-mlb-30min active + last run?
-- Are tonight's 7pm-ET (23 UTC) MLB games already in recommendations_cache /
-- pick_history? Surfaces facts via NOTICE.
DO $$
DECLARE r RECORD; v_n INT; BEGIN
  RAISE NOTICE '──────── D-685 SHIP 1 — 7pm scoring probe ────────';
  RAISE NOTICE 'now UTC=%', now();

  -- process-games-mlb-30min in cron.job?
  PERFORM 1 FROM cron.job WHERE jobname IN ('process-games-mlb-30min','process-games-mlb');
  IF FOUND THEN
    FOR r IN
      SELECT jobname, schedule, active FROM cron.job
      WHERE jobname LIKE 'process-games%' OR jobname LIKE 'resolve-picks%' OR jobname LIKE 'fetch-odds-mlb%'
      ORDER BY jobname
    LOOP
      RAISE NOTICE 'cron ACTIVE: % schedule=% (enabled=%)', r.jobname, r.schedule, r.active;
    END LOOP;
  ELSE
    RAISE NOTICE 'cron MISSING: process-games-mlb-30min NOT in cron.job';
  END IF;

  RAISE NOTICE '──── last 10 runs of process-games-mlb-30min ────';
  FOR r IN
    SELECT j.jobname, jrd.start_time, jrd.end_time, jrd.status,
           EXTRACT(EPOCH FROM (jrd.end_time - jrd.start_time))::int AS dur_s
    FROM cron.job_run_details jrd
    JOIN cron.job j ON j.jobid = jrd.jobid
    WHERE j.jobname = 'process-games-mlb-30min'
      AND jrd.start_time >= NOW() - INTERVAL '6 hours'
    ORDER BY jrd.start_time DESC LIMIT 10
  LOOP
    RAISE NOTICE 'process-games run: start=% end=% status=% dur=%s', r.start_time, r.end_time, r.status, r.dur_s;
  END LOOP;

  RAISE NOTICE '──── tonight 7pm-ET (23 UTC) MLB games — picks state ────';
  -- Use commence_time bracket for tonight (UTC 22:00 today → 06:00 tomorrow)
  -- Most ET 7pm games = 23:00-23:15 UTC. Pull pick_history rows for this window.
  SELECT COUNT(*) INTO v_n FROM pick_history
   WHERE created_at >= NOW() - INTERVAL '4 hours'
     AND is_synthetic = FALSE
     AND mlb_market_type IS NOT NULL;
  RAISE NOTICE 'pick_history rows last 4h (live MLB) total=%', v_n;

  -- per-market count in same window
  FOR r IN
    SELECT mlb_market_type, COUNT(*) AS n, MAX(created_at) AS last_created
    FROM pick_history
    WHERE created_at >= NOW() - INTERVAL '4 hours' AND is_synthetic = FALSE AND mlb_market_type IS NOT NULL
    GROUP BY mlb_market_type ORDER BY MAX(created_at) DESC
  LOOP
    RAISE NOTICE 'pick_history last 4h: % n=% last_at=%', r.mlb_market_type, r.n, r.last_created;
  END LOOP;

  -- recommendations_cache state
  RAISE NOTICE '──── recommendations_cache rows last 4h ────';
  SELECT COUNT(*) INTO v_n FROM recommendations_cache
    WHERE created_at >= NOW() - INTERVAL '4 hours';
  RAISE NOTICE 'recommendations_cache last 4h total=%', v_n;

  FOR r IN
    SELECT sport, COUNT(*) AS n, MAX(created_at) AS last_created
    FROM recommendations_cache
    WHERE created_at >= NOW() - INTERVAL '4 hours'
    GROUP BY sport ORDER BY MAX(created_at) DESC
  LOOP
    RAISE NOTICE 'rec_cache last 4h: sport=% n=% last_at=%', r.sport, r.n, r.last_created;
  END LOOP;

  -- Show the actual most-recent live-MLB pick to confirm flow
  RAISE NOTICE '──── most recent live MLB pick rows ────';
  FOR r IN
    SELECT created_at, mlb_market_type, player_name, confidence
    FROM pick_history
    WHERE is_synthetic = FALSE AND mlb_market_type IS NOT NULL
    ORDER BY created_at DESC LIMIT 5
  LOOP
    RAISE NOTICE 'last pick: at=% market=% player=% conf=%', r.created_at, r.mlb_market_type, r.player_name, r.confidence;
  END LOOP;
END $$;

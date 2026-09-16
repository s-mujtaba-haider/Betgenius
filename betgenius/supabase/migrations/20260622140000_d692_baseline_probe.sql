DO $$ DECLARE r RECORD; v_n BIGINT; BEGIN
  -- Is the drain cron currently scheduled?
  SELECT COUNT(*) INTO v_n FROM cron.job WHERE jobname = 'resolve-picks-backlog-drain';
  RAISE NOTICE 'D-692 drain cron currently in cron.job: % (0 = still paused)', v_n;

  -- Show the original snapshot row so we have its (schedule, command) for restore
  FOR r IN SELECT jobname, schedule, LEFT(command, 200) AS cmd_preview
    FROM public._d681_cron_pause_log
    WHERE jobname = 'resolve-picks-backlog-drain' AND action = 'snapshot'
    ORDER BY paused_at DESC LIMIT 1
  LOOP RAISE NOTICE 'D-681 snapshot: schedule=% cmd-preview=%', r.schedule, r.cmd_preview; END LOOP;

  -- Backlog count via direct SQL (more reliable than PostgREST count for big tables)
  SELECT COUNT(*) INTO v_n
  FROM public.pick_history
  WHERE sport='mlb' AND is_synthetic=false AND hit IS NULL AND resolved_at IS NULL
    AND game_time::timestamptz < NOW() - INTERVAL '6 hours';   -- "old" = >6h before now (game definitely over)
  RAISE NOTICE 'D-692 BACKLOG count (mlb, hit=null, resolved=null, game_time<now-6h): %', v_n;

  -- Per-game-day age histogram
  RAISE NOTICE '──── backlog age histogram ────';
  FOR r IN
    SELECT (NOW()::date - game_time::date) AS age_days, COUNT(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND hit IS NULL AND resolved_at IS NULL
      AND game_time::timestamptz < NOW() - INTERVAL '6 hours'
    GROUP BY age_days ORDER BY age_days
  LOOP RAISE NOTICE '  age_days=% n=%', r.age_days, r.n; END LOOP;
END $$;

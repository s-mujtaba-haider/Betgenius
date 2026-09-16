DO $$ DECLARE r RECORD; v_today text := to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD'); BEGIN
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-625 resolver gap diagnose — READ-ONLY — % UTC', now();
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  -- §1 — pending count by MLB market type (mlb only, non-synthetic, not voided)
  RAISE NOTICE '';
  RAISE NOTICE '[1] Pending MLB picks by market (hit IS NULL AND resolved_at IS NULL AND voided != true AND game_date IS NOT NULL):';
  FOR r IN
    SELECT
      COALESCE(mlb_market_type, '(null)') AS market,
      count(*) AS pending,
      count(*) FILTER (WHERE game_date::date <= now()::date - interval '7 days') AS older_7d,
      count(*) FILTER (WHERE game_date::date <= now()::date - interval '30 days') AS older_30d,
      min(game_date) AS oldest_date,
      max(game_date) AS newest_date
    FROM public.pick_history
    WHERE sport = 'mlb'
      AND is_synthetic = false
      AND voided IS NOT TRUE
      AND hit IS NULL
      AND resolved_at IS NULL
      AND game_date IS NOT NULL
      AND game_date::date <= now()::date    -- exclude future
    GROUP BY mlb_market_type
    ORDER BY count(*) DESC
  LOOP
    RAISE NOTICE '  % : pending=% (>7d=% >30d=%) oldest=% newest=%',
      r.market, r.pending, r.older_7d, r.older_30d, r.oldest_date, r.newest_date;
  END LOOP;

  -- §2 — Total pending vs total mlb picks
  RAISE NOTICE '';
  FOR r IN
    SELECT
      count(*) FILTER (WHERE hit IS NULL AND resolved_at IS NULL AND voided IS NOT TRUE
                       AND game_date IS NOT NULL AND game_date::date <= now()::date) AS pending,
      count(*) FILTER (WHERE hit IS NOT NULL) AS resolved,
      count(*) FILTER (WHERE voided = true) AS voided,
      count(*) AS total
    FROM public.pick_history
    WHERE sport = 'mlb' AND is_synthetic = false
  LOOP
    RAISE NOTICE '[2] MLB real picks: pending=% resolved=% voided=% total=%',
      r.pending, r.resolved, r.voided, r.total;
  END LOOP;

  -- §3 — cron schedule for resolve-picks
  RAISE NOTICE '';
  RAISE NOTICE '[3] cron.job entries for resolve-picks:';
  FOR r IN
    SELECT jobid, schedule, jobname, active
      FROM cron.job
     WHERE jobname ILIKE '%resolve%' OR jobname ILIKE '%pick%resolve%' OR command ILIKE '%resolve-picks%'
  LOOP
    RAISE NOTICE '  jobid=% sched=% name=% active=%', r.jobid, r.schedule, r.jobname, r.active;
  END LOOP;

  -- §4 — last resolve-picks cron runs (last 24h)
  RAISE NOTICE '';
  RAISE NOTICE '[4] cron.job_run_details for resolve jobs (last 24h):';
  FOR r IN
    SELECT runid, jobid, start_time, end_time, status, LEFT(COALESCE(return_message,''), 150) AS msg
      FROM cron.job_run_details
     WHERE start_time >= now() - interval '24 hours'
       AND jobid IN (SELECT jobid FROM cron.job WHERE jobname ILIKE '%resolve%' OR command ILIKE '%resolve-picks%')
     ORDER BY start_time DESC LIMIT 12
  LOOP
    RAISE NOTICE '  runid=% jobid=% start=% status=% msg=%',
      r.runid, r.jobid, r.start_time, r.status, r.msg;
  END LOOP;

  -- §5 — error_log rows from resolve-picks (last 7d)
  RAISE NOTICE '';
  RAISE NOTICE '[5] error_log from resolve-picks (last 7d):';
  FOR r IN
    SELECT error_type, count(*) AS n, min(created_at) AS first_at, max(created_at) AS last_at
      FROM public.error_log
     WHERE function_name = 'resolve-picks'
       AND created_at >= now() - interval '7 days'
     GROUP BY error_type
     ORDER BY count(*) DESC LIMIT 10
  LOOP
    RAISE NOTICE '  type=% count=% first=% last=%', r.error_type, r.n, r.first_at, r.last_at;
  END LOOP;

  -- §6 — date distribution of stuck picks in HANDLED markets
  RAISE NOTICE '';
  RAISE NOTICE '[6] HANDLED-market stuck picks by game_date (top 12 dates):';
  FOR r IN
    SELECT
      game_date::date AS day,
      count(*) AS n,
      count(DISTINCT mlb_market_type) AS markets
    FROM public.pick_history
    WHERE sport = 'mlb' AND is_synthetic = false AND voided IS NOT TRUE
      AND hit IS NULL AND resolved_at IS NULL
      AND game_date IS NOT NULL
      AND game_date::date <= now()::date
      AND mlb_market_type IN ('batter_hits','batter_hr','batter_total_bases','batter_rbis',
                              'pitcher_k','game_side','game_total')
    GROUP BY game_date::date
    ORDER BY game_date::date DESC LIMIT 12
  LOOP
    RAISE NOTICE '  % : pending=% markets=%', r.day, r.n, r.markets;
  END LOOP;

  -- §7 — recently RESOLVED picks (last 24h) — is the resolver actually running?
  RAISE NOTICE '';
  FOR r IN
    SELECT count(*) AS n,
           min(resolved_at) AS first_at, max(resolved_at) AS last_at
      FROM public.pick_history
     WHERE sport = 'mlb' AND is_synthetic = false
       AND resolved_at >= now() - interval '24 hours'
  LOOP
    RAISE NOTICE '[7] MLB picks resolved in last 24h: % (first=% last=%)',
      r.n, r.first_at, r.last_at;
  END LOOP;

  -- §8 — recently RESOLVED picks (last 7d)
  RAISE NOTICE '';
  FOR r IN
    SELECT count(*) AS n,
           min(resolved_at) AS first_at, max(resolved_at) AS last_at
      FROM public.pick_history
     WHERE sport = 'mlb' AND is_synthetic = false
       AND resolved_at >= now() - interval '7 days'
  LOOP
    RAISE NOTICE '[8] MLB picks resolved in last 7d: % (first=% last=%)',
      r.n, r.first_at, r.last_at;
  END LOOP;
END $$;

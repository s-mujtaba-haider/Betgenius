DO $$ DECLARE r RECORD; BEGIN
  -- §A — actual cron command bodies
  RAISE NOTICE '[A] cron.job command bodies (resolve jobs):';
  FOR r IN
    SELECT jobid, jobname, LEFT(command, 600) AS cmd
      FROM cron.job
     WHERE jobname ILIKE '%resolve%' OR command ILIKE '%resolve-picks%'
  LOOP
    RAISE NOTICE '  jobid=% name=%', r.jobid, r.jobname;
    RAISE NOTICE '    cmd=%', r.cmd;
  END LOOP;

  -- §B — skipped (run_log doesn't have a 'message' column on this instance)

  -- §C — heartbeat for resolve-picks
  RAISE NOTICE '';
  RAISE NOTICE '[C] heartbeat/health for resolve-picks (last 7 days):';
  FOR r IN
    SELECT check_name, status, LEFT(COALESCE(detail,''),200) AS detail, created_at
      FROM public.health_status
     WHERE check_name ILIKE '%resolve%' OR check_name ILIKE '%resolution%'
     ORDER BY created_at DESC LIMIT 8
  LOOP
    RAISE NOTICE '  check=% status=% detail=% at=%', r.check_name, r.status, r.detail, r.created_at;
  END LOOP;

  -- §D — sample 10 stuck picks from older dates — what's their state?
  RAISE NOTICE '';
  RAISE NOTICE '[D] 5 stuck picks from 2026-06-14 (handled markets) + their state:';
  FOR r IN
    SELECT id, player_name, mlb_market_type, prop_type, pick_side, line, game_date, hit, resolved_at, voided
      FROM public.pick_history
     WHERE sport = 'mlb' AND is_synthetic = false AND voided IS NOT TRUE
       AND hit IS NULL AND resolved_at IS NULL
       AND game_date::date = '2026-06-14'
       AND mlb_market_type IN ('batter_hits','batter_total_bases')
     ORDER BY created_at ASC
     LIMIT 5
  LOOP
    RAISE NOTICE '  player=% market=% prop=% side=% line=% game_date=% hit=% resolved=% voided=%',
      r.player_name, r.mlb_market_type, r.prop_type, r.pick_side, r.line, r.game_date, r.hit, r.resolved_at, r.voided;
  END LOOP;

  -- §E — total NBA pending (resolver does both sports — is the resolver budget being consumed by NBA?)
  RAISE NOTICE '';
  FOR r IN
    SELECT count(*) AS pending
      FROM public.pick_history
     WHERE sport = 'nba' AND is_synthetic = false AND voided IS NOT TRUE
       AND hit IS NULL AND resolved_at IS NULL
       AND game_date IS NOT NULL
       AND game_date::date <= now()::date
       AND game_date::date >= now()::date - interval '14 days'
  LOOP
    RAISE NOTICE '[E] NBA pending in 14d window: %', r.pending;
  END LOOP;

  -- §F — ALL sports pending in 14d window (what the resolver actually sees)
  RAISE NOTICE '';
  FOR r IN
    SELECT sport, count(*) AS pending
      FROM public.pick_history
     WHERE is_synthetic = false AND voided IS NOT TRUE
       AND hit IS NULL AND resolved_at IS NULL
       AND game_date IS NOT NULL
       AND game_date::date >= now()::date - interval '14 days'
     GROUP BY sport
     ORDER BY count(*) DESC
  LOOP
    RAISE NOTICE '[F] sport=% pending in 14d: %', COALESCE(r.sport,'(null)'), r.pending;
  END LOOP;

  -- §G — order picks the resolver would fetch (created_at ASC, first 20)
  RAISE NOTICE '';
  RAISE NOTICE '[G] First 20 picks resolver fetches (created_at ASC, in 14d window):';
  FOR r IN
    SELECT id, created_at::date AS created_day, game_date, sport, mlb_market_type, prop_type
      FROM public.pick_history
     WHERE is_synthetic = false AND voided IS NOT TRUE
       AND hit IS NULL AND resolved_at IS NULL
       AND game_date IS NOT NULL
       AND game_date::date >= now()::date - interval '14 days'
     ORDER BY created_at ASC
     LIMIT 20
  LOOP
    RAISE NOTICE '  created=% sport=% game_date=% mkt=% prop=%',
      r.created_day, r.sport, r.game_date, r.mlb_market_type, r.prop_type;
  END LOOP;
END $$;

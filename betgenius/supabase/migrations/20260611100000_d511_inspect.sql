DO $$
DECLARE r RECORD;
BEGIN
  -- §a pick_history columns relevant to CLV
  RAISE NOTICE '[D-511 §a] pick_history columns:';
  FOR r IN
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='pick_history'
      AND column_name IN ('id','odds','line','pick_side','prop_type','mlb_market_type',
                          'bookmaker','player_name','team','opponent','game_time',
                          'game_date','created_at','sport')
    ORDER BY column_name
  LOOP RAISE NOTICE '  % % nullable=%', r.column_name, r.data_type, r.is_nullable; END LOOP;

  -- §b Is there a "bookmaker" column on pick_history?
  RAISE NOTICE '[D-511 §b] pick_history "book/bookmaker" columns (any):';
  FOR r IN
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name='pick_history'
      AND (column_name ILIKE '%book%' OR column_name ILIKE '%sportsbook%')
  LOOP RAISE NOTICE '  %', r.column_name; END LOOP;

  -- §c props_cache columns (we already inspected; sanity)
  RAISE NOTICE '[D-511 §c] props_cache columns:';
  FOR r IN
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name='props_cache'
    ORDER BY ordinal_position
  LOOP RAISE NOTICE '  %  %', r.column_name, r.data_type; END LOOP;

  -- §d cron schedule for fetch-odds (and process-games)
  RAISE NOTICE '[D-511 §d] fetch-odds cron schedules:';
  FOR r IN
    SELECT jobid, jobname, schedule, active
    FROM cron.job
    WHERE jobname ILIKE '%fetch-odds%' OR jobname ILIKE '%odds%fetch%'
       OR jobname ILIKE '%process-games%' OR jobname ILIKE '%backfill%hist%'
    ORDER BY jobid
  LOOP RAISE NOTICE '  jobid=% name=% sched=% active=%', r.jobid, r.jobname, r.schedule, r.active; END LOOP;

  -- §e cache_mlb_historical_odds table (already used by D-289 backfill)
  RAISE NOTICE '[D-511 §e] cache_mlb_historical_odds columns:';
  FOR r IN
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name='cache_mlb_historical_odds'
    ORDER BY ordinal_position
  LOOP RAISE NOTICE '  %  %', r.column_name, r.data_type; END LOOP;

  -- §f Sample pick from today to understand what we have
  RAISE NOTICE '[D-511 §f] sample pick from today:';
  FOR r IN
    SELECT id, player_name, team, opponent, mlb_market_type, prop_type, line, pick_side,
           odds, game_time
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date=(NOW() AT TIME ZONE 'America/New_York')::DATE
      AND confidence >= 80
    LIMIT 3
  LOOP RAISE NOTICE '  pick=% player=% market=% line=% side=% odds=% gt=%',
    r.id, r.player_name, r.mlb_market_type, r.line, r.pick_side, r.odds, r.game_time; END LOOP;

  -- §g Sample matching props_cache row for that pick
  RAISE NOTICE '[D-511 §g] sample matching props_cache rows (any market today):';
  FOR r IN
    SELECT player_name, prop_type, line, pick_side, odds, bookmaker, first_seen, last_seen
    FROM public.props_cache
    WHERE sport='mlb' AND game_date='20260611'
      AND player_name = 'Hunter Goodman'
    ORDER BY last_seen DESC LIMIT 5
  LOOP RAISE NOTICE '  player=% prop=% line=% side=% odds=% book=% first=% last=%',
    r.player_name, r.prop_type, r.line, r.pick_side, r.odds, r.bookmaker, r.first_seen, r.last_seen; END LOOP;
END $$;

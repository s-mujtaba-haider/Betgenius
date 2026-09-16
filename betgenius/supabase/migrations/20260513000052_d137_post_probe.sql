DO $$ DECLARE c INT; w NUMERIC; t INT;
BEGIN
  SELECT COUNT(*) INTO c FROM information_schema.columns
    WHERE table_schema='public' AND table_name='pick_history' AND column_name='score_blowout_risk';
  RAISE NOTICE 'pick_history.score_blowout_risk exists: % (1=YES)', c;
  SELECT COUNT(*) INTO t FROM information_schema.tables
    WHERE table_schema='public' AND table_name='cache_game_lines';
  RAISE NOTICE 'cache_game_lines table exists: % (1=YES)', t;
  SELECT w_blowout_risk INTO w FROM algorithm_weights WHERE id=1;
  RAISE NOTICE 'w_blowout_risk @ id=1: %', w;
  -- Cache populating check (will likely be 0 immediately post-deploy
  -- until next fetch-odds cron tick fires)
  SELECT COUNT(*) INTO c FROM cache_game_lines WHERE fetched_at > NOW() - INTERVAL '30 minutes';
  RAISE NOTICE 'cache_game_lines rows in last 30 min: %', c;
END $$;

DO $$ DECLARE r RECORD; BEGIN
  RAISE NOTICE 'now=%', now();

  RAISE NOTICE '';
  RAISE NOTICE '[d-fix] pick_history sport values last 120 min:';
  FOR r IN
    SELECT COALESCE(sport,'(null)') AS sport, count(*) AS n,
           min(created_at) AS first_at, max(created_at) AS last_at
      FROM public.pick_history
     WHERE created_at >= now()-interval '120 minutes'
     GROUP BY sport
     ORDER BY count(*) DESC
  LOOP
    RAISE NOTICE '  sport=% count=% first=% last=%', r.sport, r.n, r.first_at, r.last_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '[d-fix] pick_history all-sport writes:';
  FOR r IN
    SELECT
      count(*) FILTER (WHERE created_at >= now()-interval '60 minutes') AS last_60m,
      count(*) FILTER (WHERE created_at >= now()-interval '120 minutes' AND created_at < now()-interval '60 minutes') AS prior_60m,
      max(created_at) FILTER (WHERE created_at >= now()-interval '60 minutes') AS most_recent_60m
    FROM public.pick_history
    WHERE created_at >= now()-interval '120 minutes'
  LOOP
    RAISE NOTICE '  last 60m: % picks (most recent: %)', r.last_60m, r.most_recent_60m;
    RAISE NOTICE '  prior 60m: % picks', r.prior_60m;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '[ghost] mlb_scoring_progress row for game_pk=823853 (the no-hash ghost game):';
  FOR r IN
    SELECT game_pk, last_score_hash, scored_at, tick_label
      FROM public.mlb_scoring_progress
     WHERE game_pk = 823853
  LOOP
    RAISE NOTICE '  game_pk=% hash=% scored_at=% tick=%',
      r.game_pk, COALESCE(LEFT(r.last_score_hash,16),'(null)'), r.scored_at, r.tick_label;
  END LOOP;

  -- What team is game_pk=823853? Look in mlb_games or the picks
  RAISE NOTICE '';
  RAISE NOTICE '[ghost] picks for game_pk=823853 (if any, to identify the matchup):';
  FOR r IN
    SELECT team, opponent, count(*) AS n
      FROM public.pick_history
     WHERE created_at::date = (now() AT TIME ZONE 'America/New_York')::date
       AND team IN (SELECT DISTINCT team FROM public.pick_history WHERE created_at::date = (now() AT TIME ZONE 'America/New_York')::date LIMIT 30)
     GROUP BY team, opponent
     LIMIT 0  -- skip — we use props_cache angle instead
  LOOP
    RAISE NOTICE '  team=% opp=% n=%', r.team, r.opponent, r.n;
  END LOOP;
END $$;
